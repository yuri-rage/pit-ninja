import PitAirflow from "../src/pit-airflow.js";

const pit = new PitAirflow();
pit.damperMin = 2;
pit.damperMax = 88;
pit.fanMin = 40;
pit.fanReversed = true;

// Servo Motor Control
async function controlDamper() {
    console.log("Damper Closing");
    for (let i = 100; i >= 0; i--) {
        pit.setDamperPosition(i);
        await sleep(20);
    }
    console.log("Damper Opening");
    for (let i = 0; i <= 100; i++) {
        pit.setDamperPosition(i);
        await sleep(20);
    }
}

async function controlFan() {
    console.log("Fan On");
    pit.setFanSpeed(100);
    await sleep(5000);
    console.log("Fan Min");
    pit.setFanSpeed(1);
    await sleep(10000);
    console.log("Fan Off");
    pit.setFanSpeed(0);
    await sleep(10000);
}

// promise-based sleep
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// run asynchronously
(async () => {
    //await sleep(100);
    while (true) {
        await controlFan();
        await controlDamper();
    }
})();
