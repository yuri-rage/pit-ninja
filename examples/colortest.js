import PitDisplay from "../src/pit-display.js";

const display = new PitDisplay();

function incTemp(setTemp, pitTemp) {
    const data = {
        setPoint: setTemp,
       pitTemp: ++pitTemp,
       servoPct: 0,
       fanPct: 0,
       mode: "TEST",
       units: ""
    }
    console.log(data);
    console.log(data.setPoint);
    display.update(data);

    const ms = pitTemp > setTemp - 25 ? 500 : 50;

    if (pitTemp < setTemp + 25) {
       setTimeout(() => incTemp(setTemp, pitTemp), ms);
   }
}

incTemp(230, 69);