/*
 * Meater Daemon - Bluetooth Low Energy (BLE) Meater Probe Manager
 *
 * Provides a daemon for managing Meater probes, polling for new connections
 * and updating probe data periodically (~1Hz). Uses 'node-ble' for Bluetooth
 * operations. Uses 'eventemitter3' for performant event handling.
 *
 * The MeaterDaemon and MeaterProbe classes emit events for interrupt-styled
 * implementation. MeaterDaemon also provides a 'meaters' getter that returns
 * a MAC-indexed object containing MeaterProbes that can be iterated over.
 *
 * The Meater Block must be powered off, and the probes must not be connected to
 * any other Bluetooth device (phone/tablet). Probes will generally not connect
 * to the daemon while charging (see known issues).
 *
 * Many thanks to @nathanfaber's 'meaterble' Python project for the excellent
 * reverse engineering of the Bluetooth protocol. This module is essentially
 * just a Node.JS implementation of his work at:
 * https://github.com/nathanfaber/meaterble
 *
 * (c) 2023 -- Yuri -- MIT License
 *
 * Known issues:
 *
 * If a probe fails to connect after removal from the Meater Block, first ensure
 * that the Meater Block is powered off and that the probe has not connected to
 * another device (phone/tablet). If it remains disconnected, place it into the
 * Meater Block briefly and then remove it, which may "kickstart" discovery.
 *
 * If connections continue to fail, the MeaterDaemon.restart() method can be
 * used to restart discovery non-destructively (existing probes retain their
 * connections).
 *
 * If Meater probes are charging nearby, they may advertise their addresses but
 * refuse connections, leading to repeated failed connection attempts by the
 * daemon. This causes warnings about possible memory leaks due to
 * reaching/exceeding the DBus listener limit (known issue with 'node-ble'). In
 * practice, this does not seem to affect performance. Restarting discovery
 * after some number of failed connections (MAX_CONNECTION_FAILURES) seems to
 * mitigate the issue slightly. The daemon includes a blacklisting feature that
 * can be used to further mitigate connections that repeatedly fail. Probes can
 * be blacklisted before the daemon is even started, preventing any attempt at
 * connecting to a probe that will go unused during runtime. Probes can be
 * whitelisted at any time to re-enable connections.
 *
 * PRs welcome!
 */

import EventEmitter from "eventemitter3";
import { createBluetooth } from "node-ble";
import { removeItem, FAHRENHEIT, CELSIUS } from "./utils.js";

const UPDATE_MS = 1000; // (ms) polling interval for new connections and data (temperature) updates
const CONNECT_TIMEOUT = 12000; // (ms) awaitDevice() waits this long for connection
const MAX_CONNECTION_FAILURES = 10; // daemon restarts after this many connection failures
const DISCONNECT_LIKELY = "DBusError"; /* all disconnects throw DBusErrors
                                          but not all DBusErrors are disconnects */

const APPTION_LABS = "B8:1F:5E"; // manufacturer OUI

// GATT service/characteristic UUIDs:
const DEVICE_INFO = "0000180a-0000-1000-8000-00805f9b34fb";
const FIRMWARE = "00002a26-0000-1000-8000-00805f9b34fb";

const DEVICE_DATA = "a75cc7fc-c956-488f-ac2a-2dbc08b63a04";
const TEMPERATURE = "7edda774-045e-4bbf-909b-45d1991a2876";
const BATTERY = "2adb4877-68d8-4884-bd3c-d83853bf27b8";

class MeaterProbe extends EventEmitter {
    constructor(adapter, deviceAddress, units = FAHRENHEIT) {
        super();
        this._adapter = adapter;
        this._deviceAddress = deviceAddress;
        this._device = null;
        this._server = null;
        this._isConnected = false;
        this._batteryCharacteristic = null;
        this._temperatureCharacteristic = null;
        this._probeIndex = null;
        this._firmware = null;
        this._battery = null;
        this._tip = null;
        this._ambient = null;
        this._timestamp = null;
        this._convertTemperature = null;
        this._units =
            units === FAHRENHEIT || units === CELSIUS
                ? units
                : FAHRENHEIT;
        this._updateTemperatureConversion();
    }

    static bytesToInt(byte0, byte1) {
        return (byte1 << 8) + byte0;
    }

    static toCelsius(value) {
        return [(value + 8) / 16, "°C"];
    }

    static toFahrenheit(value) {
        return [(MeaterProbe.toCelsius(value)[0] * 9) / 5 + 32, "°F"];
    }

    get isConnected() {
        return this._isConnected;
    }

    get probeAddress() {
        return this._deviceAddress; // MAC address
    }

    get probeIndex() {
        // device "name" - is a string containing an integer value 1-4
        return this._probeIndex;
    }

    get firmware() {
        return this._firmware;
    }

    get tip() {
        return this._tip;
    }

    get ambient() {
        return this._ambient;
    }

    get battery() {
        return this._battery;
    }

    get lastUpdateMs() {
        if (this._timestamp !== null) {
            const currentTime = new Date();
            return currentTime - this._timestamp;
        }
        return null;
    }

    get lastUpdateTime() {
        return this._timestamp;
    }

    get units() {
        return this._units;
    }

    set units(value) {
        if (
            value === FAHRENHEIT ||
            value === CELSIUS
        ) {
            this._units = value;
            this._updateTemperatureConversion();
        } else {
            console.warn(`MeaterProbe: Ignored invalid units (${value}).`);
        }
    }

    _updateTemperatureConversion() {
        this._convertTemperature =
            this._units === CELSIUS
                ? MeaterProbe.toCelsius
                : MeaterProbe.toFahrenheit;
    }

    // once connected, a probe is initialized by collecting the
    // GATT characteristics will be read to update the probe's
    // temperature and battery data
    async _initialize() {
        try {
            const devInfoService = await this._server.getPrimaryService(
                DEVICE_INFO
            );
            const firmwareCharacteristic =
                await devInfoService.getCharacteristic(FIRMWARE);

            const devDataService = await this._server.getPrimaryService(
                DEVICE_DATA
            );

            this._temperatureCharacteristic =
                await devDataService.getCharacteristic(TEMPERATURE);

            this._batteryCharacteristic =
                await devDataService.getCharacteristic(BATTERY);

            const buffer = await firmwareCharacteristic.readValue();
            [this._firmware, this._probeIndex] = buffer.toString().split("_");
        } catch (error) {
            // ! Apption warns they may change Bluetooth protocol/messages without notice
            const probeName = `Probe ${
                this._probeIndex || this._deviceAddress
            }`;
            const warnStrings = [
                `WARNING: Failed to retrieve GATT characteristic(s) for ${probeName}.`,
                "Apption may have introduced a breaking change to Meater's Bluetooth protocol.",
            ];
            const errString = error.name || error.message || "Unknown error";
            console.warn(warnStrings.join("\n"));
            throw new Error(
                `${probeName} failed initialization (${errString}).`
            );
        }
    }

    async connect() {
        try {
            this._device = await this._adapter.waitDevice(
                this._deviceAddress,
                CONNECT_TIMEOUT
            );
            await this._device.connect();
            this._server = await this._device.gatt();
            await this._initialize();
            this._isConnected = true;
            await this.update();
            this.emit("connect", this);
        } catch (error) {
            this._device.disconnect(); // should help remove listeners
            this.emit("connectFailed", this._deviceAddress);
        }
    }

    async disconnect() {
        try {
            this._device.disconnect();
        } catch (error) {
            console.error(`${this._deviceAddress} disconnect error: ${error}`);
        } finally {
            this._isConnected = false;
            this.emit("disconnect", this._deviceAddress);
        }
    }

    // updates the probe's connection state, battery, and temperature data
    // scheduled at ~1Hz, non-blocking
    async update() {
        try {
            this._isConnected = await this._device.isConnected();
            if (this._isConnected) {
                const tempBuffer =
                    await this._temperatureCharacteristic.readValue();
                const battBuffer =
                    await this._batteryCharacteristic.readValue();
                const tip = MeaterProbe.bytesToInt(
                    tempBuffer[0],
                    tempBuffer[1]
                );
                const ra = MeaterProbe.bytesToInt(tempBuffer[2], tempBuffer[3]);
                const oa = MeaterProbe.bytesToInt(tempBuffer[4], tempBuffer[5]);
                const ambient =
                    tip +
                    Math.max(0, ((ra - Math.min(48, oa)) * 16 * 589) / 1487);
                [this._tip, this._units] = this._convertTemperature(tip);
                [this._ambient, this._units] =
                    this._convertTemperature(ambient);
                this._battery =
                    MeaterProbe.bytesToInt(battBuffer[0], battBuffer[1]) * 10;
                this._timestamp = new Date();

                this.emit("update", {
                    probeIndex: this._probeIndex,
                    address: this._deviceAddress,
                    tip: this._tip,
                    ambient: this._ambient,
                    units: this._units,
                    battery: this._battery,
                    timestamp: this._timestamp,
                });
            }
        } catch (error) {
            if (error.name !== DISCONNECT_LIKELY) {
                console.error(
                    `Probe ${this._probeIndex} update error: ${error}`
                );
            }
            await this.disconnect();
        } finally {
            if (this._isConnected) {
                setTimeout(() => this.update(), UPDATE_MS);
            }
        }
    }

    destroy() {
        this._device.disconnect(); // should help remove listeners
    }
}

class MeaterDaemon extends EventEmitter {
    constructor(units = FAHRENHEIT) {
        super();
        const { bluetooth, destroy } = createBluetooth();
        this._bluetooth = bluetooth;
        this._destroy = destroy;
        this._restartCount = -1;
        this._adapter = null;
        this._active = false;
        this._meaters = {};
        this._knownDevices = {};
        this._blacklist = [];
        this._errCount = 0;
        this._units =
            units === FAHRENHEIT || units === CELSIUS
                ? units
                : FAHRENHEIT;
    }

    getKnownDeviceName(id) {
        if (id in this._knownDevices) {
            return `Probe ${this._knownDevices[id]}`;
        }
        return `${id}`;
    }

    get meaters() {
        return this._meaters;
    }

    async start() {
        this._adapter = await this._bluetooth.defaultAdapter();
        await this._adapter.startDiscovery();
        this._active = true;
        this._errCount = 0;
        this._restartCount++;
        const restarted = this._restartCount > 0 ? "re" : "";
        const count =
            this._restartCount > 0 ? ` (count=${this._restartCount})` : "";
        console.log(`MeaterDaemon ${restarted}started${count}...`);
        setTimeout(() => this._update(), UPDATE_MS);
    }

    blacklist(id) {
        this._blacklist.push(id);
    }

    whitelist(id) {
        this._blacklist = removeItem(this._blacklist, id);
    }

    isBlacklisted(id) {
        return this._blacklist.includes(id);
    }

    isWhitelisted(id) {
        return !this.isBlacklisted(id);
    }

    get restartCount() {
        return this._restartCount;
    }

    get units() {
        return this._units;
    }

    set units(value) {
        if (
            value === FAHRENHEIT ||
            value === CELSIUS
        ) {
            this._units = value;
            for (const id of Object.keys(this._meaters)) {
                this._meaters[id].units = value;
            }
        } else {
            console.warn(`MeaterDaemon: Ignored invalid units (${value}).`);
        }
    }

    async _attemptConnection(id) {
        if (this.isBlacklisted(id)) {
            return; // simply skip connection attempt on blacklist
        }
        const probe = new MeaterProbe(this._adapter, id, this._units);
        probe.on("connect", (thisProbe) => {
            this._knownDevices[thisProbe.probeAddress] = thisProbe.probeIndex;
            this.emit("probeConnect", thisProbe);
            console.log(
                `Probe ${thisProbe.probeIndex} connected. (${thisProbe.probeAddress} -- ${thisProbe.firmware})`
            );
        });
        probe.once("connectFailed", (id) => {
            this.emit("probeDisconnect", id);
            probe.removeAllListeners();
            console.error(`${this.getKnownDeviceName(id)} failed to connect.`);
            delete this._meaters[id];
            this._errCount++;
        });
        probe.once("disconnect", (id) => {
            this.emit("probeDisconnect", id);
            probe.removeAllListeners();
            console.log(`${this.getKnownDeviceName(id)} disconnected.`);
            delete this._meaters[id];
        });
        probe.connect();
        this._meaters[id] = probe;
    }

    async _update() {
        if (this._active) {
            if (this._errCount > MAX_CONNECTION_FAILURES) {
                console.log(
                    `MeaterDaemon connection failures exceeded ${MAX_CONNECTION_FAILURES}, restarting...`
                );
                setTimeout(() => this.restart(), UPDATE_MS);
                return;
            }
            try {
                const currentDevices = await this._adapter.devices();
                for (const id of currentDevices) {
                    if (id.startsWith(APPTION_LABS) && !this._meaters[id]) {
                        this._attemptConnection(id);
                    }
                }
            } catch (error) {
                console.error(`MeaterDaemon update error: ${error}`);
            } finally {
                setTimeout(() => this._update(), UPDATE_MS);
            }
        }
    }

    async stop() {
        await this._adapter.stopDiscovery();
        this._active = false;
        console.log("MeaterDaemon stopped.");
    }

    async restart() {
        await this.stop();
        setTimeout(() => this.start(), UPDATE_MS);
    }

    destroy() {
        this._destroy();
    }
}

export { MeaterDaemon as default, MeaterDaemon, MeaterProbe };

/********** EXAMPLE USAGE **********/
/*
if (require.main === module) {
    (async () => {
        // create and start the daemon
        // invoke with MeaterDaemon(CELSIUS) as desired
        // units can be changed during runtime without restarting
        const daemon = new MeaterDaemon();
        await daemon.start();

        // Listen for probe connect events
        daemon.on("probeConnect", (probe) => {
            probe.on("update", (data) => {
                console.log(
                    `Probe ${data.probeIndex}: Tip=${data.tip.toFixed(1)}${
                        data.units
                    }, Ambient=${data.ambient.toFixed(1)}${
                        data.units
                    }, Battery=${data.battery}%`
                );
            });

            probe.once("disconnect", (id) => {
                probe.removeAllListeners();
            });
        });

        // Listen for Ctrl-C and exit gracefully
        process.on("SIGINT", async () => {
            console.log("\nReceived SIGINT.\nStopping MeaterDaemon...");
            await daemon.stop();
            daemon.destroy();
            process.exit(0);
        });
    })();
}
*/
