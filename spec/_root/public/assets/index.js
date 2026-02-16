const el = document.getElementById("clock");
setInterval(() => {
  el.textContent = new Date().toLocaleTimeString();
}, 1000);
