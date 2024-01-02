import { ConfigUtil, FAHRENHEIT, CELSIUS } from "./src/utils.js";
import MeaterDaemon from "./src/meater-daemon.js";
import PitPID from "./src/pit-pid.js";
import PitAirflow from "./src/pit-airflow.js";
import PitDisplay from "./src/pit-display.js";

const config = new ConfigUtil();

const units = { F: FAHRENHEIT, C: CELSIUS }[config.get("units")];

const display = new PitDisplay();

// connect to i2c devices
const pit = new PitAirflow();
pit.fanReversed = config.get("fan.reverse", false);

// create and start the daemon
const daemon = new MeaterDaemon();
daemon.units = units;
await daemon.start();

const pid = new PitPID();
pid.pid = config.get("PID", { P: 2.5, I: 0.0035, D: 6 });
pid.fanMinSpeed = config.get("fan.minSpeed", 0);
pid.fanMaxSpeed = config.get("fan.maxSpeed", 100);
pid.fanMaxStartupSpeed = config.get("fan.maxStartupSpeed", 100);
pid.fanActiveFloor = config.get("fan.onAbove", 0);
pid.servoMinPos = config.get("servo.minPosition", 0);
pid.servoMaxPos = config.get("servo.maxPosition", 0);
pid.setPoint = config.get("setPoint", 230);
pid.lidOpenOffset = config.get("lid.lidOpenOffset", 5);
pid.lidOpenDuration = config.get("lid.lidOpenDuration", 240);

pid.on("status", (data) => {
    // console.log(data);
    display.update(data);
}).on("output", (data) => {
    if (data.type === "fan") {
        pit.setFanSpeed(data.value);
    }
    if (data.type === "servo") {
        pit.setDamperPosition(data.value);
    }
});

// Listen for probe connect events
daemon.on("probeConnect", (probe) => {
    probe.on("update", (data) => {
        pid.updateProbe(data);
        // TODO: send better data to the display driver
        if (data.probeIndex === "1") display._probe1tip = data.tip;
        if (data.probeIndex === "2") display._probe2tip = data.tip;
        console.log(`${data.probeIndex}  ${data.tip}${data.units}`);
    });

    probe.once("disconnect", (id) => {
        pid.removeProbe(id);
        probe.removeAllListeners();
    });
});

// Listen for Ctrl-C and exit gracefully
process.on("SIGINT", async () => {
    console.log("\nReceived SIGINT.\nStopping MeaterDaemon...");
    pit.setFanSpeed(0);
    await daemon.stop();
    daemon.destroy();
    process.exit(0);
});
