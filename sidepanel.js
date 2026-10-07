const $ = (s) => document.querySelector(s);
const els = {
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebarToggle'),
  newChat: $('#newChat'),
  chatSearch: $('#chatSearch'),
  chatList: $('#chatList'),
  settingsBtn: $('#settingsBtn'),
  exportBtn: $('#exportBtn'),
  chatTitle: $('#chatTitle'),
  status: $('#status'),
  notice: $('#notice'),
  welcome: $('#welcome'),
  messages: $('#messages'),
  prompt: $('#prompt'),
  composer: $('#composer'),
  sendBtn: $('#sendBtn'),
  stopBtn: $('#stopBtn'),
  attachPage: $('#attachPage'),
  selectionBtn: $('#selectionBtn'),
  contextChip: $('#contextChip'),
  contextLabel: $('#contextLabel'),
  clearContext: $('#clearContext'),
  counter: $('#counter'),
  pageToolsBtn: $('#pageToolsBtn'),
  toolsMenu: $('#toolsMenu'),
  settingsDialog: $('#settingsDialog'),
  responseStyle: $('#responseStyle'),
  answerLanguage: $('#answerLanguage'),
  systemPrompt: $('#systemPrompt'),
  autoTitle: $('#autoTitle'),
  saveSettings: $('#saveSettings'),
  downloadBox: $('#downloadBox'),
  downloadProgress: $('#downloadProgress'),
  downloadPercent: $('#downloadPercent')
};

const DEFAULT_SETTINGS = {
  responseStyle: 'balanced',
  answerLanguage: 'auto',
  systemPrompt: 'You are a helpful, accurate local assistant running inside Google Chrome. Be clear, practical, and do not invent facts.',
  autoTitle: true
};

let chats = [];
let activeChatId = null;
let settings = { ...DEFAULT_SETTINGS };
let modelSession = null;
let busy = false;
let abortController = null;
let pageContext = null;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function now() { return Date.now(); }

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

function activeChat() {
  return chats.find((c) => c.id === activeChatId) || null;
}

async function persist() {
  await chrome.storage.local.set({ nanoChats: chats, nanoActiveChatId: activeChatId, nanoSettings: settings });
}

function newChatData() {
  return { id: uid(), title: 'שיחה חדשה', createdAt: now(), updatedAt: now(), messages: [] };
}

async function createNewChat() {
  if (modelSession) {
    modelSession.destroy?.();
    modelSession = null;
  }
  const chat = newChatData();
  chats.unshift(chat);
  activeChatId = chat.id;
  pageContext = null;
  renderAll();
  await persist();
  els.prompt.focus();
}

function formatTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

function renderChatList() {
  const q = els.chatSearch.value.trim().toLowerCase();
  els.chatList.innerHTML = '';
  for (const chat of chats.filter((c) => c.title.toLowerCase().includes(q))) {
    const btn = document.createElement('button');
    btn.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
    const title = document.createElement('strong');
    title.textContent = chat.title;
    const meta = document.createElement('small');
    meta.textContent = formatTime(chat.updatedAt) + ' • ' + chat.messages.length + ' הודעות';
    btn.append(title, meta);
    btn.addEventListener('click', async () => {
      activeChatId = chat.id;
      pageContext = null;
      modelSession?.destroy?.();
      modelSession = null;
      renderAll();
      await persist();
    });
    els.chatList.appendChild(btn);
  }
}

function messageNode(message, index) {
  const row = document.createElement('div');
  row.className = 'message ' + message.role;

  const wrap = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text;
  wrap.appendChild(bubble);

  const actions = document.createElement('div');
  actions.className = 'message-actions';

  const copy = document.createElement('button');
  copy.textContent = 'העתק';
  copy.addEventListener('click', () => navigator.clipboard.writeText(message.text));
  actions.appendChild(copy);

  if (message.role === 'user') {
    const reuse = document.createElement('button');
    reuse.textContent = 'השתמש שוב';
    reuse.addEventListener('click', () => {
      els.prompt.value = message.text;
      autoResize();
      updateCounter();
      els.prompt.focus();
    });
    actions.appendChild(reuse);
  }

  const del = document.createElement('button');
  del.textContent = 'מחק';
  del.addEventListener('click', async () => {
    const chat = activeChat();
    chat.messages.splice(index, 1);
    chat.updatedAt = now();
    renderMessages();
    renderChatList();
    await persist();
  });
  actions.appendChild(del);

  wrap.appendChild(actions);
  row.appendChild(wrap);
  return { row, bubble };
}

function renderMessages() {
  const chat = activeChat();
  els.messages.innerHTML = '';
  const hasMessages = !!chat?.messages.length;
  els.welcome.classList.toggle('hidden', hasMessages);
  els.messages.classList.toggle('hidden', !hasMessages);

  if (!chat) return;
  chat.messages.forEach((m, i) => els.messages.appendChild(messageNode(m, i).row));
  els.messages.scrollTop = els.messages.scrollHeight;
  els.chatTitle.value = chat.title;
}

function renderContext() {
  if (!pageContext) {
    els.contextChip.classList.add('hidden');
    return;
  }
  els.contextChip.classList.remove('hidden');
  els.contextLabel.textContent = pageContext.selection
    ? 'טקסט מסומן מצורף'
    : 'עמוד מצורף: ' + (pageContext.title || 'ללא כותרת');
}

function renderAll() {
  renderChatList();
  renderMessages();
  renderContext();
}

function containsHebrew(text) {
  return /[\u0590-\u05FF]/.test(text);
}

async function createTranslator(sourceLanguage, targetLanguage) {
  if (!('Translator' in self)) {
    throw new Error('Translator API אינו זמין בגרסת Chrome הזו.');
  }
  const availability = await Translator.availability({ sourceLanguage, targetLanguage });
  if (availability === 'unavailable') {
    throw new Error('חבילת התרגום המבוקשת אינה זמינה.');
  }
  return Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        const percent = Math.round(event.loaded * 100);
        setStatus('מוריד תרגום ' + percent + '%', 'warn');
      });
    }
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

function styleInstruction() {
  const map = {
    concise: 'Keep the answer concise and direct.',
    balanced: 'Give a balanced answer with enough explanation to be useful.',
    detailed: 'Give a detailed, structured answer with useful explanation.'
  };
  return map[settings.responseStyle] || map.balanced;
}

async function ensureSession() {
  if (modelSession) return modelSession;
  if (!('LanguageModel' in self)) {
    throw new Error('Prompt API לא זמין. נדרש Chrome 138 ומעלה במחשב נתמך.');
  }

  const options = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }]
  };
  const availability = await LanguageModel.availability(options);
  if (availability === 'unavailable') throw new Error('Gemini Nano אינו זמין במכשיר הזה.');

  if (availability === 'downloadable' || availability === 'downloading') {
    els.downloadBox.classList.remove('hidden');
    setStatus('מכין מודל', 'warn');
  }

  modelSession = await LanguageModel.create({
    ...options,
    initialPrompts: [{
      role: 'system',
      content: settings.systemPrompt + '\n' + styleInstruction()
    }],
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        const p = Math.round(event.loaded * 100);
        els.downloadBox.classList.remove('hidden');
        els.downloadProgress.value = p;
        els.downloadPercent.textContent = p + '%';
        setStatus('מוריד ' + p + '%', 'warn');
        if (p >= 100) setTimeout(() => els.downloadBox.classList.add('hidden'), 800);
      });
    }
  });
  setStatus('מוכן • מקומי', 'ok');
  return modelSession;
}

async function extractPage(selectionOnly = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
    throw new Error('לא ניתן לקרוא את העמוד הזה. פתח עמוד http/https רגיל.');
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (onlySelection) => {
      const selected = window.getSelection()?.toString().trim() || '';
      if (onlySelection) return { selection: true, title: document.title, url: location.href, text: selected };

      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,canvas,nav,footer,header,form').forEach((n) => n.remove());
      const text = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      return { selection: false, title: document.title, url: location.href, text };
    },
    args: [selectionOnly]
  });

  if (!result?.text) {
    throw new Error(selectionOnly ? 'לא נמצא טקסט מסומן בעמוד.' : 'לא נמצא טקסט קריא בעמוד.');
  }

  result.text = result.text.slice(0, 14000);
  return result;
}

async function attachPage(selectionOnly = false) {
  hideNotice();
  setStatus('קורא עמוד...', 'warn');
  try {
    pageContext = await extractPage(selectionOnly);
    renderContext();
    setStatus('מוכן • מקומי', 'ok');
  } catch (error) {
    setStatus('שגיאה', 'error');
    showNotice(error.message);
  }
}

function buildInput(userText) {
  let input = userText;
  if (pageContext) {
    input += '\n\nPAGE CONTEXT\nTitle: ' + pageContext.title +
      '\nURL: ' + pageContext.url +
      '\nContent:\n' + pageContext.text;
  }
  return input;
}

async function normalizeInputForModel(text, userQuestion) {
  const answerLanguage = settings.answerLanguage;
  const inputContainsHebrew = containsHebrew(text);
  const questionIsHebrew = containsHebrew(userQuestion);
  let modelInput = text;

  if (inputContainsHebrew) {
    setStatus('מתרגם קלט...', 'warn');
    modelInput = await translate(text, 'he', 'en');
  }

  const wantsHebrew = answerLanguage === 'he' || (answerLanguage === 'auto' && questionIsHebrew);
  const languageInstruction = wantsHebrew
    ? '\nAnswer in English first; the application will translate your final answer to Hebrew.'
    : '\nAnswer in English.';

  return { modelInput: modelInput + languageInstruction, wantsHebrew };
}

async function sendPrompt(rawText) {
  if (busy) return;
  const text = rawText.trim();
  if (!text) return;

  const chat = activeChat();
  if (!chat) return;

  hideNotice();
  busy = true;
  abortController = new AbortController();
  els.sendBtn.disabled = true;
  els.stopBtn.classList.remove('hidden');

  chat.messages.push({ role: 'user', text, at: now() });
  chat.updatedAt = now();

  if (settings.autoTitle && chat.messages.length === 1 && chat.title === 'שיחה חדשה') {
    chat.title = text.replace(/\s+/g, ' ').slice(0, 42) || 'שיחה חדשה';
  }

  els.prompt.value = '';
  autoResize();
  updateCounter();
  renderAll();
  await persist();

  const placeholder = { role: 'assistant', text: '', at: now() };
  chat.messages.push(placeholder);
  const index = chat.messages.length - 1;
  const node = messageNode(placeholder, index);
  node.bubble.classList.add('typing');
  els.messages.appendChild(node.row);
  els.messages.scrollTop = els.messages.scrollHeight;

  try {
    const fullInput = buildInput(text);
    const { modelInput, wantsHebrew } = await normalizeInputForModel(fullInput, text);
    const model = await ensureSession();
    setStatus('חושב...', 'warn');

    let english = '';
    const stream = model.promptStreaming(modelInput, { signal: abortController.signal });

    for await (const chunk of stream) {
      english = chunk;
      if (!wantsHebrew) {
        placeholder.text = english;
        node.bubble.textContent = english;
        node.bubble.classList.add('typing');
        els.messages.scrollTop = els.messages.scrollHeight;
      }
    }

    if (wantsHebrew) {
      setStatus('מתרגם תשובה...', 'warn');
      placeholder.text = await translate(english, 'en', 'he');
      node.bubble.textContent = placeholder.text;
    } else {
      placeholder.text = english;
    }

    node.bubble.classList.remove('typing');
    setStatus('מוכן • מקומי', 'ok');
  } catch (error) {
    node.bubble.classList.remove('typing');
    if (error?.name === 'AbortError') {
      placeholder.text = placeholder.text || 'התגובה הופסקה.';
      node.bubble.textContent = placeholder.text;
      setStatus('הופסק', 'warn');
    } else {
      placeholder.text = 'שגיאה: ' + (error?.message || String(error));
      node.bubble.textContent = placeholder.text;
      setStatus('שגיאה', 'error');
      showNotice(error?.message || String(error));
    }
  } finally {
    chat.updatedAt = now();
    busy = false;
    abortController = null;
    els.sendBtn.disabled = false;
    els.stopBtn.classList.add('hidden');
    renderChatList();
    await persist();
    els.prompt.focus();
  }
}

const TOOL_PROMPTS = {
  'summarize-page': 'Summarize the attached page clearly. Preserve the important facts and structure.',
  'key-points': 'Extract the most important key points from the attached page as a concise structured list.',
  'explain-page': 'Explain the attached page in simple, clear language. Clarify difficult terms when needed.',
  'translate-page': 'Translate the important content of the attached page into Hebrew, preserving meaning and structure.',
  'ask-page': ''
};

async function runPageTool(tool) {
  els.toolsMenu.classList.add('hidden');
  await attachPage(false);
  if (!pageContext) return;

  if (tool === 'ask-page') {
    els.prompt.placeholder = 'שאל משהו על העמוד המצורף...';
    els.prompt.focus();
    return;
  }
  await sendPrompt(TOOL_PROMPTS[tool] || 'Analyze the attached page.');
}

async function checkAvailability() {
  if (!('LanguageModel' in self)) {
    setStatus('לא נתמך', 'error');
    showNotice('Prompt API לא נמצא. נדרש Chrome 138 ומעלה במחשב שולחני נתמך.');
    return;
  }
  try {
    const a = await LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    });
    const map = {
      available: ['מוכן • מקומי', 'ok'],
      downloadable: ['מוכן להורדה', 'warn'],
      downloading: ['בהורדה', 'warn'],
      unavailable: ['לא זמין', 'error']
    };
    const [label, type] = map[a] || [a, ''];
    setStatus(label, type);
  } catch (error) {
    setStatus('שגיאה', 'error');
    showNotice(error.message);
  }
}

function autoResize() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = Math.min(150, els.prompt.scrollHeight) + 'px';
}

function updateCounter() {
  els.counter.textContent = els.prompt.value.length.toLocaleString('he-IL');
}

async function exportChat() {
  const chat = activeChat();
  if (!chat) return;
  const lines = ['# ' + chat.title, '', 'נוצר באמצעות Gemini Nano Local Workspace', ''];
  for (const m of chat.messages) {
    lines.push(m.role === 'user' ? '## אתה' : '## Gemini Nano', '', m.text, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (chat.title || 'gemini-nano-chat').replace(/[\\/:*?"<>|]/g, '-') + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadState() {
  const data = await chrome.storage.local.get(['nanoChats', 'nanoActiveChatId', 'nanoSettings']);
  chats = Array.isArray(data.nanoChats) ? data.nanoChats : [];
  settings = { ...DEFAULT_SETTINGS, ...(data.nanoSettings || {}) };

  if (!chats.length) chats = [newChatData()];
  activeChatId = chats.some((c) => c.id === data.nanoActiveChatId) ? data.nanoActiveChatId : chats[0].id;

  els.responseStyle.value = settings.responseStyle;
  els.answerLanguage.value = settings.answerLanguage;
  els.systemPrompt.value = settings.systemPrompt;
  els.autoTitle.checked = settings.autoTitle;

  renderAll();
  await persist();
}

async function consumePending() {
  const { nanoPendingPrompt, nanoCommand } = await chrome.storage.local.get(['nanoPendingPrompt', 'nanoCommand']);

  if (nanoCommand?.type === 'new-chat') {
    await chrome.storage.local.remove('nanoCommand');
    await createNewChat();
  }

  if (nanoPendingPrompt?.text) {
    await chrome.storage.local.remove('nanoPendingPrompt');
    els.prompt.value = nanoPendingPrompt.text;
    autoResize();
    updateCounter();
    if (nanoPendingPrompt.autoSend) await sendPrompt(nanoPendingPrompt.text);
  }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.nanoPendingPrompt?.newValue?.text) {
    const pending = changes.nanoPendingPrompt.newValue;
    await chrome.storage.local.remove('nanoPendingPrompt');
    els.prompt.value = pending.text;
    autoResize();
    updateCounter();
    if (pending.autoSend) await sendPrompt(pending.text);
  }
  if (changes.nanoCommand?.newValue?.type === 'new-chat') {
    await chrome.storage.local.remove('nanoCommand');
    await createNewChat();
  }
});

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendPrompt(els.prompt.value);
});
els.prompt.addEventListener('input', () => { autoResize(); updateCounter(); });
els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.stopBtn.addEventListener('click', () => abortController?.abort());
els.newChat.addEventListener('click', createNewChat);
els.chatSearch.addEventListener('input', renderChatList);
els.sidebarToggle.addEventListener('click', () => els.sidebar.classList.toggle('collapsed'));
els.attachPage.addEventListener('click', () => attachPage(false));
els.selectionBtn.addEventListener('click', () => attachPage(true));
els.clearContext.addEventListener('click', () => { pageContext = null; renderContext(); });
els.exportBtn.addEventListener('click', exportChat);

els.chatTitle.addEventListener('change', async () => {
  const chat = activeChat();
  if (!chat) return;
  chat.title = els.chatTitle.value.trim() || 'שיחה חדשה';
  chat.updatedAt = now();
  renderChatList();
  await persist();
});

els.pageToolsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  els.toolsMenu.classList.toggle('hidden');
});
document.addEventListener('click', () => els.toolsMenu.classList.add('hidden'));
els.toolsMenu.addEventListener('click', (e) => e.stopPropagation());

document.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => runPageTool(btn.dataset.tool));
});

els.settingsBtn.addEventListener('click', () => els.settingsDialog.showModal());
els.saveSettings.addEventListener('click', async (e) => {
  e.preventDefault();
  settings = {
    responseStyle: els.responseStyle.value,
    answerLanguage: els.answerLanguage.value,
    systemPrompt: els.systemPrompt.value.trim() || DEFAULT_SETTINGS.systemPrompt,
    autoTitle: els.autoTitle.checked
  };
  modelSession?.destroy?.();
  modelSession = null;
  await persist();
  els.settingsDialog.close();
  setStatus('הגדרות נשמרו', 'ok');
});

(async () => {
  await loadState();
  await checkAvailability();
  await consumePending();
  els.prompt.focus();
})();
