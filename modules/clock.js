const NanoTimer = require('nanotimer');

module.exports = function(tickCallback) {
  let timer;

  let playing = false;
  let tickLength = microseconds(120);

  function tick() {
    if (playing) {
      tickCallback();
    }
  }

  function microseconds(tempo) {
    return parseInt(60000000 / (tempo * 24));
  }

  return {
    setTempo: function(tempo) {
      const tlength = microseconds(tempo);
      if (tlength != tickLength) {
        tickLength = tlength;
        if (timer) {
          timer.clearInterval();
          timer.setInterval(tick, '', `${tickLength}u`);
        }
      }
    },

    start: function() {
      playing = true;
      timer = new NanoTimer();
      timer.setInterval(tick, '', `${tickLength}u`);
    },

    stop: function() {
      playing = false;
      if (timer) {
        timer.clearInterval();
        delete timer;
      }
    }
  };
};
