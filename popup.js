const els = {
  status: document.querySelector('#status'),
  notice: document.querySelector('#notice'),
  messages: document.querySelector('#messages'),
  form: document.querySelector('#chatForm'),
  prompt: document.querySelector('#prompt'),
  send: document.querySelector('#sendBtn'),
  clear: document.querySelector('#clearBtn'),
  downloadBox: document.querySelector('#downloadBox'),
  downloadProgress: document.querySelector('#downloadProgress'),
  downloadPercent: document.querySelector('#downloadPercent'),
};

let session = null;
let busy = false;

function setStatus(text, type = '') {
  els.status.textContent = text;
  els.status.className = 'status' + (type ? ' ' + type : '');
}

function showNotice(text) {
  els.notice.textContent = text;
  els.notice.classList.remove('hidden');
}

function hideNotice() {
  els.notice.classList.add('hidden');
}

function addMessage(role, text = '') {
  const row = document.createElement('div');
  row.className = 'message ' + role;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  row.appendChild(bubble);
  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;

  return bubble;
}

function setBusy(value) {
  busy = value;
  els.send.disabled = value;
  els.prompt.disabled = value;
  els.clear.disabled = value;
}

function containsHebrew(text) {
  return /[\u0590-\u05FF]/.test(text);
}

async function createTranslator(sourceLanguage, targetLanguage) {
  if (!('Translator' in self)) {
    throw new Error('Translator API is not available in this Chrome version.');
  }

  const availability = await Translator.availability({
    sourceLanguage,
    targetLanguage,
  });

  if (availability === 'unavailable') {
    throw new Error('Translation for this language pair is unavailable.');
  }

  return Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        const percent = Math.round(event.loaded * 100);
        setStatus('מוריד תרגום ' + percent + '%', 'warn');
      });
    },
  });
}

async function translate(text, sourceLanguage, targetLanguage) {
  const translator = await createTranslator(sourceLanguage, targetLanguage);
  try {
    return await translator.translate(text);
  } finally {
    translator.destroy?.();
  }
}

async function ensureSession() {
  if (session) return session;

  if (!('LanguageModel' in self)) {
    throw new Error('Prompt API אינו זמין. נדרש Chrome 138 ומעלה במחשב נתמך.');
  }

  const options = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };

  const availability = await LanguageModel.availability(options);

  if (availability === 'unavailable') {
    throw new Error('Gemini Nano אינו זמין במחשב או בהתקנת Chrome הזו.');
  }

  if (availability === 'downloadable' || availability === 'downloading') {
    setStatus('המודל דורש הורדה', 'warn');
    els.downloadBox.classList.remove('hidden');
  }

  session = await LanguageModel.create({
    ...options,
    initialPrompts: [
      {
        role: 'system',
        content: 'You are a concise, helpful local assistant running inside Google Chrome. Answer clearly and accurately.',
      },
    ],
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        const percent = Math.round(event.loaded * 100);
        els.downloadBox.classList.remove('hidden');
        els.downloadProgress.value = percent;
        els.downloadPercent.textContent = percent + '%';
        setStatus('מוריד ' + percent + '%', 'warn');

        if (percent >= 100) {
          setTimeout(() => els.downloadBox.classList.add('hidden'), 600);
        }
      });
    },
  });

  setStatus('מוכן • מקומי', 'ok');
  return session;
}

async function askModel(userText, outputBubble) {
  const isHebrew = containsHebrew(userText);
  let modelInput = userText;

  if (isHebrew) {
    setStatus('מתרגם לאנגלית...', 'warn');
    modelInput = await translate(userText, 'he', 'en');
  }

  const model = await ensureSession();
  setStatus('חושב...', 'warn');

  let englishResult = '';
  const stream = model.promptStreaming(modelInput);

  for await (const chunk of stream) {
    englishResult = chunk;
    if (!isHebrew) {
      outputBubble.textContent = englishResult;
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }

  if (isHebrew) {
    setStatus('מתרגם לעברית...', 'warn');
    outputBubble.textContent = await translate(englishResult, 'en', 'he');
  }

  setStatus('מוכן • מקומי', 'ok');
}

async function checkAvailability() {
  hideNotice();

  if (!('LanguageModel' in self)) {
    setStatus('לא נתמך', 'error');
    showNotice('Prompt API לא נמצא. ודא שאתה משתמש ב-Chrome 138 ומעלה במחשב שולחני נתמך.');
    return;
  }

  try {
    const availability = await LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });

    const labels = {
      available: ['מוכן • מקומי', 'ok'],
      downloadable: ['מוכן להורדה', 'warn'],
      downloading: ['בהורדה', 'warn'],
      unavailable: ['לא זמין', 'error'],
    };

    const [text, type] = labels[availability] || [availability, ''];
    setStatus(text, type);

    if (availability === 'downloadable') {
      showNotice('המודל עדיין לא הורד. לחיצה על "שלח" תתחיל את ההורדה המקומית ותציג את ההתקדמות.');
    } else if (availability === 'unavailable') {
      showNotice('Gemini Nano אינו זמין כרגע במכשיר הזה. בדוק את דרישות Chrome והחומרה.');
    }
  } catch (error) {
    setStatus('שגיאה', 'error');
    showNotice(error.message);
  }
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;

  const text = els.prompt.value.trim();
  if (!text) return;

  hideNotice();
  addMessage('user', text);
  els.prompt.value = '';

  const answer = addMessage('assistant', '...');
  setBusy(true);

  try {
    await askModel(text, answer);
  } catch (error) {
    answer.textContent = 'שגיאה: ' + (error?.message || String(error));
    setStatus('שגיאה', 'error');

    if (error?.name === 'NotSupportedError') {
      showNotice('השפה או יכולת המודל אינן נתמכות ישירות. עבור עברית התוסף מנסה להשתמש ב-Translator API המקומי של Chrome.');
    }
  } finally {
    setBusy(false);
    els.prompt.focus();
  }
});

els.clear.addEventListener('click', () => {
  session?.destroy?.();
  session = null;

  els.messages.innerHTML = '';
  addMessage('assistant', 'השיחה נוקתה. אפשר להתחיל מחדש.');
  setStatus('מוכן', 'ok');
  els.prompt.focus();
});

els.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.form.requestSubmit();
  }
});

checkAvailability();
