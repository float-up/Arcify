document.querySelector('#current-case').textContent = new URLSearchParams(location.search).get('case') || '初始页面';
document.querySelector('#popup').addEventListener('click', () => {
  window.open('peek-test.html?case=popup', '_blank', 'popup,width=600,height=480');
});
document.querySelector('#script-open').addEventListener('click', () => {
  window.open('peek-test.html?case=script-open', '_blank');
});
document.querySelector('#script-blank').addEventListener('click', () => {
  const win = window.open('', '_blank');
  if (win) win.location.href = new URL('peek-test.html?case=script-blank', location.href).href;
});
