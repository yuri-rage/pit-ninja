/*
 * SimpleTouchscreen Driver
 *
 * Implements a touch event device driver using the 'evdev' and 'eventemitter3'
 * npm packages. Designed around an SPI touchscreen on Raspberry Pi but should
 * be flexible enough to work with other Linux-based touch input devices. Emits
 * 'touch' events of type 'start', 'hold', and 'end' containing x and y screen
 * position.
 *
 * The constructor includes an optional 'debounceInterval' (milliseconds) argument
 * to preclude touch events from triggering in rapid succession.
 *
 * The length of time it takes for a 'hold' event to be emitted can be controlled
 * by the touchHoldTimeout argument. Set 0 to disable 'hold' events.
 *
 * An additional, optional 'emitAll' argument will emit 'position' events between
 * 'start' and 'end' for use in gesture detection or calibration routines.
 *
 * Tested on the Miuzei 4" HDMI TFT Touchscreen and Raspberry Pi 5/Bookworm.
 * https://www.amazon.com/gp/product/B07XBVF1C9
 *
 * Known issues:
 *
 * The 'evdev' module is extremely minimal and sometimes fails inelegantly.
 * SimpleTouchscreen implements an 'initialized' property that, if set false,
 * indicates failure to initialize or a subsequent uncaught exception. Polling
 * that property occasionally and reconstructing the object after failure may
 * mitigate the fragility of the dependency on 'evdev'.
 *
 * (c) 2023 -- Yuri -- MIT License
 */

import EvdevReader from "evdev";
import EventEmitter from "eventemitter3";

const INPUT_BY_PATH = "/dev/input/by-path";

class SimpleTouchscreen extends EventEmitter {
    constructor(
        target,
        debounceInterval = 0,
        touchHoldTimeout = 750,
        emitAll = false
    ) {
        super();
        this._reader = new EvdevReader();
        this._device = null;
        this._resolvedTarget = null;
        this._isInitialized = false;
        this._absolutePosition = {};
        this._emitAll = emitAll;
        this._emitTouchStart = false;
        this._hasTouchStart = false;
        this._emitTouchEnd = false;
        this._debounceInterval = debounceInterval;
        this._touchHoldTimeout = touchHoldTimeout;
        this._lastTouchEventTime = 0;
        this._touchHoldId = null;

        // ! 'evdev' is fragile, so we just fail early and often
        process.on("uncaughtException", (error) => {
            this._isInitialized = false;
            console.error("SimpleTouchScreen error:", error.message);
        });

        this._attachListeners();
        this._openDevice(target);
    }

    _attachListeners() {
        this._reader
            .on("EV_KEY", (data) => {
                this._emitTouchEnd =
                    data.code === "BTN_TOUCH" &&
                    data.value === 0 &&
                    this._hasTouchStart;

                this._emitTouchStart =
                    data.code === "BTN_TOUCH" && data.value === 1;
            })
            .on("EV_ABS", (data) => {
                this._absolutePosition[data.code] = data.value;
                if (data.code === "ABS_PRESSURE") {
                    this._handleTouchEvent();
                }
            })
            .on("error", (e) => {
                this._isInitialized = false;
                console.error("SimpleTouchScreen error:", e);
                this.destroy();
            });
    }

    _handleTouchEvent() {
        const currentTime = Date.now();
        const timeElapsed = currentTime - this._lastTouchEventTime;

        if (this._emitAll) {
            this.emit("touch", {
                type: "position",
                x: this._absolutePosition.ABS_X,
                y: this._absolutePosition.ABS_Y,
            });
        }

        if (this._emitTouchStart && timeElapsed >= this._debounceInterval) {
            this.emit("touch", {
                type: "start",
                x: this._absolutePosition.ABS_X,
                y: this._absolutePosition.ABS_Y,
            });
            this._lastTouchEventTime = currentTime;
            this._emitTouchStart = false;
            this._hasTouchStart = true;
            if (this._touchHoldTimeout > 0) {
                this._touchHoldId = setTimeout(() => {
                    this.emit("touch", {
                        type: "hold",
                        x: this._absolutePosition.ABS_X,
                        y: this._absolutePosition.ABS_Y,
                    });
                }, this._touchHoldTimeout);
            }
        }

        if (this._emitTouchEnd) {
            this.emit("touch", {
                type: "end",
                x: this._absolutePosition.ABS_X,
                y: this._absolutePosition.ABS_Y,
            });
            this._lastTouchEventTime = currentTime;
            this._emitTouchEnd = false;
            this._hasTouchStart = false;
            clearTimeout(this._touchHoldId);
        }
    }

    _openDevice(target) {
        let searchPath = INPUT_BY_PATH;
        let searchTarget = target;
        const splitIndex = target.lastIndexOf("/");
        if (splitIndex !== -1) {
            searchPath = target.substring(0, splitIndex);
            searchTarget = target.substring(splitIndex + 1);
        }

        this._reader.search(searchPath, searchTarget, (err, files) => {
            if (err) {
                this._isInitialized = false;
                console.error("SimpleTouchScreen error:", err);
                this._reader.removeAllListeners();
                return;
            }

            if (files.length > 0) {
                this._device = this._reader.open(files[0]);
                this._resolvedTarget = files[0];
            }

            if (files.length > 1) {
                console.warn(
                    "SimpleTouchScreen warning: Multiple matching device targets found.",
                    "Opened first match."
                );
            }

            this._device.once("open", () => {
                this._isInitialized = true;
                console.log(
                    `Touchscreen initialized (${this._resolvedTarget}).`
                );
            });
        });
    }

    get isInitialized() {
        return this._isInitialized;
    }

    get device() {
        // generally not needed but emits an "open" event that may be useful
        return this._device;
    }

    destroy() {
        this._reader.close();
        this._reader.removeAllListeners();
    }
}

export { SimpleTouchscreen as default, SimpleTouchscreen };
