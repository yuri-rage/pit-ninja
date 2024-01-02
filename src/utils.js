/*
 * utils.js
 *
 * Exports commonly used functions using ES6 syntax.
 *
 * Use "type": "module" in 'package.json' to import.
 *
 *
 * (c) 2023 -- Yuri -- MIT License
 */

import config from "config";

export const FAHRENHEIT = "°F";
export const CELSIUS = "°C";

// implements a default value option for 'config.get'
export class ConfigUtil extends config.constructor {
    get(key, defaultValue) {
        if (!config.has(key)) {
            console.warn(
                `Config: ${key} not found, using default (${defaultValue}).`
            );
        }
        return config.has(key) ? super.get(key) : defaultValue;
    }
}

export function millis() {
    const now = new Date();
    return now.getTime();
}

export function removeItem(arr, item) {
    return arr.filter((value) => value !== item);
}

export function constrain(value, minValue, maxValue) {
    return Math.min(Math.max(value, minValue), maxValue);
}

export function constrainBoolean(value) {
    return value === true;
}

export function mapRange(value, min, max, newMin, newMax) {
    const clampedValue = constrain(value, min, max);
    const normalizedValue = (clampedValue - min) / (max - min);
    return normalizedValue * (newMax - newMin) + newMin;
}

export function mapPct(o, a, b) {
    o = constrain(o, 0, 100);
    return ((b - a) * o) / 100 + a;
}

// weighted moving average to smooth response
export function calcExpMovingAverage(smooth, currAverage, newValue) {
    if (currAverage === null || isNaN(currAverage)) {
        return newValue;
    }
    const delta = newValue - currAverage;
    const weightedDelta = smooth * delta;
    return currAverage + weightedDelta;
}

// weighted average, ignoring low outliers (like newly introduced probes)
export function calcLowerTrimmedMean(arr, deviationThreshold) {
    const sorted = arr.sort();

    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const deviation = Math.sqrt(
        sorted.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) /
            sorted.length
    );

    const trimmedValues = sorted.filter(
        (value) => value >= mean - deviationThreshold * deviation
    );

    const trimmedMean =
        trimmedValues.reduce((sum, value) => sum + value, 0) /
        trimmedValues.length;

    return trimmedMean;
}

// there are almost always better ways to do things than 'sleep'
// but it's often useful for testing/debugging, so it's here
export async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
