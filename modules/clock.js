const EventEmitter = require('events').EventEmitter;
const NanoTimer = require('nanotimer');

module.exports = function() {
  let clock = new EventEmitter();
  let timer = new NanoTimer();

  timer.setInterval(tick, '', '25000u');

  let playing = false;

  function tick() {
    if (playing) {
      clock.emit('tick');
    }
  }

  clock.setTempo = function(tempo) {
    const tickLength = parseInt(60000000 / (tempo * 24));
    timer.clearInterval();
    timer.setInterval(tick, '', `${tickLength}u`);
  };

  clock.start = function() {
    playing = true;
  };

  clock.stop = function() {
    playing = false;
  };

  return clock;
};
