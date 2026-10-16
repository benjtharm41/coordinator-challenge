import './style.css';
import { startApp } from './ui/app';

startApp(document.getElementById('app')!);

// Work offline after the first visit (only in the built site, not while developing).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* the game still works without it */
    });
  });
}
