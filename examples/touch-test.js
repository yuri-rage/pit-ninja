import SimpleTouchscreen from "../src/simple-touchscreen.js";
    // A simple keyword target will match the first device
    // in '/dev/input/by-path' containing the keyword.
    // If you know the full device path, you can specify it
    // explicitly (e.g., '/dev/input/event1').
    const touchscreen = new SimpleTouchscreen("spi", 200);

    touchscreen.on("touch", (data) => {
        console.log(`Touch  X=${data.x}  Y=${data.y}  ${data.type}`);
    });

    process.on("SIGINT", () => {
        console.log("\nCaught SIGINT, exiting.");
        touchscreen.destroy();
        process.exit();
    });

