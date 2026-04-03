const audio = new Audio("audio/quack.mp3");

document.getElementById("play").onclick = () => {
  audio.play().catch(() => alert("Missing quack.mp3"));
};

document.getElementById("stop").onclick = () => {
  audio.pause();
  audio.currentTime = 0;
};
