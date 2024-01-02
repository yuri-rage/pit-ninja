/*
 * Pit Display
 *
 * Draws BBQ pit controller graphics to a framebuffer device such as '/dev/fb0'.
 *
 * Should work equally well on an HDMI display as with an SPI display, so
 * long as a framebuffer device is exposed to the OS. Optimized for a 4"
 * HDMI display in portrait mode (800x480)
 *
 * (c) 2023 -- Yuri -- MIT License
 */

import { execSync } from "child_process";
import { createCanvas, registerFont } from "canvas";
import Chart from "chart.js/auto";
import fs from "fs";

const JUSTIFY = {
    LEFT: 0,
    RIGHT: 1,
    CENTER: 2,
    TOP: 3,
    BOTTOM: 4,
    VCENTER: 5,
    FIT: 6,
    FIXED: 7,
};

function getScreenResolution() {
    try {
        let command = "fbset -s | grep geometry";
        let result = execSync(command).toString();
        const match = result.match(/geometry (\d+) (\d+)/);
        if (match) {
            const w = parseInt(match[1], 10);
            const h = parseInt(match[2], 10);
            return [w, h];
        } else {
            throw new Error("Failed to parse screen resolution");
        }
    } catch (error) {
        console.error("Error getting screen resolution:", error.message);
        return [800, 480]; // default to 800x480 display
    }
}

function splitFontString(fontString) {
    // return font size as an integer plus the rest of the string
    const regex = /(\d+px)\s*/;
    const match = fontString.match(regex);

    if (match) {
        const fontSize = match[1];
        const restOfString = fontString.replace(regex, "").trim();

        return [parseInt(fontSize), restOfString];
    } else {
        return [0, fontString.trim()];
    }
}

function justifyText(
    canvas,
    text,
    hAlign = JUSTIFY.LEFT,
    vAlign = JUSTIFY.BOTTOM,
    scale = JUSTIFY.FIT,
    margin = 10
) {
    const ctx = canvas.getContext("2d");

    if (scale === JUSTIFY.FIT) {
        const [origFontSize, fontStyle] = splitFontString(ctx.font);
        const maxFontHeight = canvas.height - margin * 2;
        const maxFontWidth = canvas.width - margin * 2;
        let fontSize = canvas.height;
        ctx.font = `${fontSize}px ${fontStyle}`;
        while (
            !(
                ctx.measureText(text).width <= maxFontWidth &&
                ctx.measureText(text).actualBoundingBoxAscent <= maxFontHeight
            )
        ) {
            fontSize--;

            // Break the loop if the font size becomes too small
            if (fontSize <= 0) {
                ctx.font = `${origFontSize}px ${fontStyle}`;
                break;
            }

            ctx.font = `${fontSize}px ${fontStyle}`;
        }
    }

    const boundingBox = ctx.measureText(text);
    const textWidth = boundingBox.width;
    const textHeight = boundingBox.actualBoundingBoxAscent;

    let x, y;

    switch (hAlign) {
        case JUSTIFY.LEFT:
            x = margin;
            break;
        case JUSTIFY.RIGHT:
            x = canvas.width - margin - textWidth;
            break;
        case JUSTIFY.CENTER:
            x = (canvas.width - textWidth) / 2;
            break;
        default:
            x = margin;
    }

    switch (vAlign) {
        case JUSTIFY.TOP:
            y = textHeight + margin;
            break;
        case JUSTIFY.BOTTOM:
            y = canvas.height - margin;
            break;
        case JUSTIFY.VCENTER:
            y = (canvas.height + textHeight) / 2;
            break;
        default:
            y = margin + textHeight;
    }

    // Draw the text
    ctx.fillText(text, x, y);
}

function temperatureToColor(temp, setPoint) {
    // TODO: make this work for Celsius
    const setPointMargin = 25;
    const setPointYellow = setPoint - setPointMargin;
    const setPointRed = setPoint + setPointMargin;

    let redComponent = 0;
    let greenComponent = 0;
    let blueComponent = 0;

    if (temp <= 70) {
        return "#0000FF"; // Blue for temperatures below 0 degrees
    } else if (temp <= 115) {
        const pctGreen = (temp - 70) / (115 - 70);
        greenComponent = Math.round(0xff * pctGreen);
        blueComponent = 0xff - greenComponent;
    } else if (temp < setPointYellow) {
        const pctRed = (temp - 115) / (setPointYellow - 115);
        redComponent = 0xff * pctRed;
        greenComponent = 0xff;
    } else if (temp < setPointRed) {
        const pctGreen =
            (temp - setPointYellow) / (setPointRed - setPointYellow);
        redComponent = 0xff;
        greenComponent = 0xff * (1 - pctGreen);
    } else {
        return "#FF0000";
    }
    const hexString = (
        (Math.round(redComponent) << 16) |
        (Math.round(greenComponent) << 8) |
        Math.round(blueComponent)
    )
        .toString(16)
        .padStart(6, "0");
    return `#${hexString.toUpperCase()}`;
}

function percentToColor(pct) {
    let redComponent = 0;
    let greenComponent = 0;
    let blueComponent = 0;

    if (pct <= 10) {
        return "#0000FF"; // red at less than 10%
    } else if (pct <= 50) {
        const pctGreen = (pct - 10) / (50 - 10);
        greenComponent = Math.round(0xff * pctGreen);
        redComponent = 0xff;
    } else if (pct <= 90) {
        const pctRed = 1 - (pct - 50) / (90 - 50);
        redComponent = 0xff * pctRed;
        greenComponent = 0xff;
    } else {
        return "#00FF00"; // green at full
    }
    const hexString = (
        (Math.round(redComponent) << 16) |
        (Math.round(greenComponent) << 8) |
        Math.round(blueComponent)
    )
        .toString(16)
        .padStart(6, "0");
    return `#${hexString.toUpperCase()}`;
}

function drawFan(size = 48, color = "white", rotation = 0) {
    const [canvas, ctx] = createCvsCtx(size, size);
    const [bladeCanvas, bladeCtx] = createCvsCtx(size, size);

    bladeCtx.fillStyle = color;

    // fan blade
    bladeCtx.beginPath();
    bladeCtx.arc(size / 2, size / 2, size / 7, -1.7, Math.PI, true);
    bladeCtx.lineTo(size / 4.42, size / 2.24);
    bladeCtx.arcTo(size / 84, size / 2.8, size / 6.5, size / 5.8, size / 5.6);
    bladeCtx.arcTo(size / 2.8, size / -11.2, size / 1.5, size / 28, size / 2.4);
    bladeCtx.arcTo(
        size / 1.487,
        size / 21,
        size / 1.46,
        size / 14,
        size / 17.68
    );
    bladeCtx.lineTo(size / 1.46, size / 12.9);
    bladeCtx.arcTo(
        size / 1.45,
        size / 12.44,
        size / 1.46,
        size / 12.08,
        size / 186.7
    );
    bladeCtx.arcTo(
        size / 2.1,
        size / 6.2,
        size / 2.1,
        size / 2.75,
        size / 3.36
    );
    bladeCtx.closePath();
    bladeCtx.fill();

    // draw 3 fan blades 120 degrees apart
    for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.translate(size / 2, size / 2);
        ctx.rotate((i * 2 * Math.PI) / 3 + rotation);
        ctx.drawImage(bladeCanvas, -size / 2, -size / 2);
        ctx.restore();
    }

    ctx.fillStyle = color;

    // fan hub
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 10, 0, 2 * Math.PI);
    ctx.closePath();
    ctx.fill();

    return canvas;
}

function drawDamper(servoPct, size, color) {
    const [canvas, ctx] = createCvsCtx(size, size);

    const percentage = Math.max(0, Math.min(servoPct, 100)) / 2;
    const remainingPercentage = 100 - percentage;

    const data = {
        datasets: [
            {
                data: [remainingPercentage, percentage],
                backgroundColor: [color, "black"],
                borderColor: [color],
                borderWidth: 1,
            },
        ],
    };

    const options = {
        legend: {
            display: false,
        },
        layout: {
            padding: {
                left: -5,
                right: -5,
                top: -10,
                bottom: -5,
            },
        },
        rotation: 90,
    };

    new Chart(ctx, {
        type: "pie",
        data: data,
        options: options,
    });

    return canvas;
}

function drawBattery(
    batteryPct,
    height,
    strokeColor = "white",
    fillColor = "black"
) {
    const [canvas, ctx] = createCvsCtx(height / 2.5, height);

    const data = {
        labels: ["Battery"],
        datasets: [
            {
                data: [batteryPct],
                backgroundColor: [percentToColor(batteryPct)],
                borderWidth: 0,
                barThickness: canvas.width,
            },
        ],
    };

    const options = {
        scales: {
            x: {
                display: false,
            },
            y: {
                display: false,
                max: 100,
                min: 0,
            },
        },
        plugins: {
            legend: {
                display: false,
            },
        },
    };

    new Chart(ctx, {
        type: "bar",
        data: data,
        options: options,
    });

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);

    return canvas;
}

function createCvsCtx(width, height, colorMode) {
    const cvs = createCanvas(width, height);
    const ctx = cvs.getContext("2d", { pixelFormat: colorMode });
    return [cvs, ctx];
}

class PitDisplay {
    constructor(device = "/dev/fb0", colorMode = "RGB16_565") {
        const [width, height] = getScreenResolution();

        this._framebuffer = fs.openSync(device, "w");
        this._colorMode = colorMode;
        this._width = width;
        this._height = height;
        this._margin = 10;
        this._fanRotation = 0;

        // for most on-screen text
        registerFont("./resources/Roboto-Regular.ttf", { family: "Roboto" });

        // for large temperature digits
        registerFont("./resources/Roboto-Black.ttf", {
            family: "Roboto-Black",
        });

        // TODO: get rid of these in favor of better stuff
        this._probe1tip = 0;
        this._probe2tip = 0;

        [this._canvas, this._ctx] = createCvsCtx(width, height, colorMode);
    }

    _createTopBanner(setPoint, mode, hasAlarm) {
        const [canvas, ctx] = createCvsCtx(
            this._width,
            this._height / 16,
            this._colorMode
        );

        ctx.fillStyle = hasAlarm ? "yellow" : "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = hasAlarm ? "black" : "white";
        ctx.font = `${canvas.height - this._margin * 2}px Roboto`;

        justifyText(
            canvas,
            `${setPoint.toFixed(0)}°`,
            JUSTIFY.LEFT,
            JUSTIFY.VCENTER,
            JUSTIFY.FIT
        );
        justifyText(canvas, mode, JUSTIFY.RIGHT, JUSTIFY.VCENTER, JUSTIFY.FIT);
        return canvas;
    }

    _createPitTempCanvas(pitTemp, setPoint) {
        const [canvas, ctx] = createCvsCtx(
            this._width,
            this._height / 5,
            this._colorMode
        );

        if (isNaN(pitTemp) || pitTemp === null) {
            pitTemp = 0; // arbitrarily low
        }

        if (isNaN(setPoint) || setPoint === null) {
            setPoint = 500; // arbitrarily high
        }

        ctx.fillStyle = temperatureToColor(pitTemp, setPoint);
        ctx.font = `${canvas.height}px Roboto-Black`;

        const text = pitTemp === 0 ? "N/A" : `${pitTemp.toFixed(1)}°`;

        justifyText(canvas, text, JUSTIFY.CENTER, JUSTIFY.VCENTER, JUSTIFY.FIT);

        return canvas;
    }

    _createFanServoCanvas(fanPct, servoPct) {
        const [canvasText, ctxText] = createCvsCtx(
            this._width,
            this._height / 18,
            this._colorMode
        );

        if (isNaN(fanPct) || fanPct === null) {
            fanPct = 0;
        }

        if (isNaN(servoPct) || servoPct === null) {
            servoPct = 0;
        }

        ctxText.font = `${canvasText.height}px Roboto`;

        const servoColor = servoPct < 1 ? "gray" : "white";
        ctxText.fillStyle = servoColor;
        justifyText(
            canvasText,
            `Damper: ${servoPct.toFixed(0)}%`,
            JUSTIFY.RIGHT,
            JUSTIFY.VCENTER,
            JUSTIFY.FIT
        );

        const fanColor = fanPct < 1 ? "gray" : "white";
        ctxText.fillStyle = fanColor;
        justifyText(
            canvasText,
            `Blower: ${fanPct.toFixed(0)}%`,
            JUSTIFY.LEFT,
            JUSTIFY.VCENTER,
            JUSTIFY.FIT
        );

        const [canvas, ctx] = createCvsCtx(
            this._width,
            canvasText.height * 2 + this._margin,
            this._colorMode
        );

        ctx.drawImage(canvasText, 0, 0);

        const fan = drawFan(canvasText.height, fanColor, this._fanRotation);

        const damper = drawDamper(servoPct, canvasText.height, servoColor);

        ctx.drawImage(fan, this._margin * 3, canvasText.height + this._margin);
        ctx.drawImage(
            damper,
            this._width - (this._margin * 3 + fan.width),
            canvasText.height + this._margin
        );

        // TODO: display lid countdown timer here
        ctx.fillStyle = "white";
        ctx.font = ctxText.font;
        justifyText(
            canvas,
            "Lid Closed",
            JUSTIFY.CENTER,
            JUSTIFY.BOTTOM,
            JUSTIFY.FIXED
        );

        return canvas;
    }

    _createProbeCanvas(name, isConnected, tipTemp, desiredTemp, battery) {
        const [canvas, ctx] = createCvsCtx(
            this._width,
            this._height / 18,
            this._colorMode
        );

        ctx.font = `${canvas.height}px Roboto`;
        if (!isConnected) {
            const battCanvas = drawBattery(
                0,
                canvas.height - this._margin * 2,
                "black",
                "black"
            );
            const [textCanvas, textCtx] = createCvsCtx(
                canvas.width - battCanvas.width - this._margin,
                canvas.height,
                this._colorMode
            );
            textCtx.fillStyle = "gray";
            justifyText(
                textCanvas,
                `${name}`,
                JUSTIFY.LEFT,
                JUSTIFY.VCENTER,
                JUSTIFY.FIT
            );
            ctx.drawImage(battCanvas, this._margin, this._margin);
            ctx.drawImage(textCanvas, this._margin + battCanvas.width, 0);
            return canvas;
        }

        ctx.fillStyle = "white";
        let battStrokeColor = "white";
        let battFillColor = "black";
        let desiredTempText = "";
        if (
            !(isNaN(desiredTemp) || desiredTemp === null || desiredTemp === 0)
        ) {
            ctx.fillStyle = temperatureToColor(tipTemp, desiredTemp);
            battFillColor = ctx.fillStyle;
            battStrokeColor = "black";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "black";
            desiredTempText = `(${desiredTemp.toFixed(0)}°)`;
        }

        const battCanvas = drawBattery(
            battery,
            canvas.height - this._margin * 2,
            battStrokeColor,
            "black"
        );

        const [textCanvas, textCtx] = createCvsCtx(
            canvas.width - battCanvas.width - this._margin,
            canvas.height,
            this._colorMode
        );

        textCtx.fillStyle = battFillColor;
        textCtx.fillRect(0, 0, textCanvas.width, textCanvas.height);
        textCtx.fillStyle = battStrokeColor;

        justifyText(
            textCanvas,
            `${name} ${desiredTempText}`,
            JUSTIFY.LEFT,
            JUSTIFY.VCENTER,
            JUSTIFY.FIT
        );

        justifyText(
            textCanvas,
            `${tipTemp.toFixed(1)}°`,
            JUSTIFY.RIGHT,
            JUSTIFY.VCENTER,
            JUSTIFY.FIT
        );

        ctx.fillStyle = "black";
        ctx.fillRect(
            this._margin,
            this._margin,
            battCanvas.width,
            battCanvas.height
        );
        ctx.drawImage(battCanvas, this._margin, this._margin);
        ctx.drawImage(textCanvas, this._margin + battCanvas.width, 0);

        return canvas;
    }

    update(data) {
        try {
            const topBanner = this._createTopBanner(
                data.setPoint,
                data.mode,
                false // TODO: handle lid open alarm
            );
            const pitTempCanvas = this._createPitTempCanvas(
                data.pitTemp,
                data.setPoint
            );

            const fanServoCanvas = this._createFanServoCanvas(
                data.fanPct,
                data.servoPct
            );

            const probe1Canvas = this._createProbeCanvas(
                "Probe 1",
                true,
                78,
                null,
                20
            );
            const probe2Canvas = this._createProbeCanvas(
                "Pork",
                true,
                190,
                195,
                80
            );
            const probe3Canvas = this._createProbeCanvas(
                "Probe 3",
                false,
                100,
                195,
                100
            );
            const probe4Canvas = this._createProbeCanvas(
                "Probe 4",
                false,
                100,
                195,
                100
            );

            let x = 0;
            let y = 0;

            this._clear();
            this._ctx.drawImage(topBanner, x, y);
            y += topBanner.height;
            this._ctx.drawImage(pitTempCanvas, x, y);
            y += pitTempCanvas.height;
            this._ctx.drawImage(fanServoCanvas, x, y);
            y += fanServoCanvas.height + this._margin * 2;
            this._ctx.drawImage(probe1Canvas, x, y);
            y += probe1Canvas.height;
            this._ctx.drawImage(probe2Canvas, x, y);
            y += probe2Canvas.height;
            this._ctx.drawImage(probe3Canvas, x, y);
            y += probe3Canvas.height;
            this._ctx.drawImage(probe4Canvas, x, y);
            y += probe4Canvas.height;


            // TODO: make sure pit-pid emits scaled fan/servo values that go 0-100 and
            // TODO: are truly indicative of state

            this._draw(); // TODO: probably draw on setTimeout but update canvasses as updates roll in
        } catch (error) {
            console.log(error);
            // TODO: maybe nothing?
        }
    }

    _clear() {
        this._ctx.fillStyle = "black";
        this._ctx.fillRect(0, 0, this._width, this._height);
    }

    _draw() {
        const buffer = this._canvas.toBuffer("raw");
        fs.writeSync(this._framebuffer, buffer, 0, buffer.byteLength, 0);
        this._fanRotation += Math.PI / 4;
        if (this._fanRotation >= Math.PI * 2) {
            this._fanRotation = 0;
        }
    }
}

export { PitDisplay as default, PitDisplay };
