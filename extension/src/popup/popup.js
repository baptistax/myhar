'use strict';

const openCaptureButton = document.getElementById('openCapture');

openCaptureButton.addEventListener('click', () => {
  const captureUrl = chrome.runtime.getURL('src/capture/capture.html');
  chrome.tabs.create({ url: captureUrl });
});
