const pjson = require('../package.json');

document.getElementById('version').innerHTML = pjson.version;
document.getElementById('description').innerHTML = pjson.description;
document.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', function (e) {
    e.preventDefault();
    const { shell } = require('electron');
    shell.openExternal(this.getAttribute('href'));
  });
});
