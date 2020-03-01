const NanoTimer = require('nanotimer');

module.exports = function(tickCallback) {
  const timer = new NanoTimer();

  let playing = false;
  let tickLength = microseconds(120);
  timer.setInterval(tick, '', `${tickLength}u`);

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
        timer.clearInterval();
        timer.setInterval(tick, '', `${tickLength}u`);
      }
    },

    start: function() {
      playing = true;
    },

    stop: function() {
      playing = false;
    }
  };
};
