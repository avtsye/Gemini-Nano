chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'nano-ask-selection',
    title: 'שאל את Gemini Nano על הטקסט המסומן',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'nano-summarize-selection',
    title: 'סכם עם Gemini Nano',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'nano-explain-selection',
    title: 'הסבר עם Gemini Nano',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.windowId || !info.selectionText) return;

  const prefixes = {
    'nano-ask-selection': 'ענה על הטקסט הבא ועזור לי להבין אותו:',
    'nano-summarize-selection': 'סכם בקצרה ובבהירות את הטקסט הבא:',
    'nano-explain-selection': 'הסבר את הטקסט הבא בצורה פשוטה וברורה:'
  };

  const prefix = prefixes[info.menuItemId];
  if (!prefix) return;

  await chrome.storage.local.set({
    nanoPendingPrompt: {
      text: prefix + '\n\n' + info.selectionText,
      autoSend: true,
      at: Date.now()
    }
  });

  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    // The prompt remains queued and will be picked up next time the panel opens.
  }
});
