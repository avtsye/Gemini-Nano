const statusEl = document.querySelector('#status');
const detailEl = document.querySelector('#statusDetail');
const dot = document.querySelector('#dot');

function setStatus(text, detail, type = '') {
  statusEl.textContent = text;
  detailEl.textContent = detail;
  dot.className = 'dot' + (type ? ' ' + type : '');
}

async function check() {
  if (!('LanguageModel' in self)) {
    setStatus('Prompt API לא זמין', 'נדרש Chrome 138 ומעלה ומחשב נתמך', 'error');
    return;
  }
  try {
    const availability = await LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    });
    if (availability === 'available') {
      setStatus('Gemini Nano מוכן', 'המודל המקומי זמין לשימוש', 'ok');
    } else if (availability === 'downloadable') {
      setStatus('המודל מוכן להורדה', 'ההורדה תתחיל בשימוש הראשון', 'warn');
    } else if (availability === 'downloading') {
      setStatus('המודל בהורדה', 'Chrome מכין את Gemini Nano', 'warn');
    } else {
      setStatus('המודל אינו זמין', 'בדוק את דרישות Chrome והחומרה', 'error');
    }
  } catch (error) {
    setStatus('לא ניתן לבדוק', error.message || String(error), 'error');
  }
}

async function openPanel(newChat = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (newChat) {
    await chrome.storage.local.set({ nanoCommand: { type: 'new-chat', at: Date.now() } });
  }
  await chrome.sidePanel.open({ windowId: tab.windowId });
  window.close();
}

document.querySelector('#openPanel').addEventListener('click', () => openPanel(false));
document.querySelector('#newChat').addEventListener('click', () => openPanel(true));
check();
