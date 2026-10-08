const $ = (s) => document.querySelector(s);
const els = Object.fromEntries([
  'sidebar','sidebarToggle','newChat','chatSearch','folderFilter','chatList','settingsBtn','diagnosticsBtn',
  'exportBtn','chatTitle','status','contextMeter','notice','welcome','messages','prompt','composer','sendBtn',
  'stopBtn','attachPage','selectionBtn','fileBtn','screenBtn','fileInput','attachments','contextChip','contextLabel',
  'livePage','clearContext','counter','pageToolsBtn','paletteBtn','toolsMenu','settingsDialog','profile','responseStyle',
  'answerLanguage','temperature','temperatureValue','topK','topKValue','systemPrompt','autoTitle','smartContext',
  'saveSettings','downloadBox','downloadProgress','downloadPercent','setupBox','setupDetail','prepareAiBtn',
  'diagnosticsDialog','diagnosticsContent','closeDiagnostics','refreshDiagnostics','runSelfTest','paletteDialog',
  'paletteSearch','paletteList','attachMenuBtn','attachMenu','moreBtn','moreMenu','debugLanguageBtn','languageDebugDialog',
  'languageDebugContent','closeLanguageDebug','copyLanguageDebug','moreExportBtn','moreSettingsBtn','toastHost','composerHint'
].map(id => [id, $('#'+id)]));

const DEFAULT_SETTINGS = {
  profile:'general',
  responseStyle:'balanced',
  answerLanguage:'auto',
  temperature:0.5,
  topK:6,
  systemPrompt:'You are a helpful, accurate local assistant running inside Google Chrome. Be clear, practical, and do not invent facts. Match the exact scope requested by the user. If the user asks for one sentence, return one sentence only. Never append unrelated alternatives, duplicated text, or text in another language.',
  autoTitle:true,
  smartContext:true
};

const PROFILE_PROMPTS = {
  general:'Be useful, accurate, and practical.',
  coder:'Act as a careful software engineer. Prefer correct, maintainable solutions and explain important tradeoffs.',
  research:'Act as a careful research assistant. Distinguish facts, uncertainty, and inference.',
  editor:'Act as a precise editor. Improve clarity, structure, grammar, and tone while preserving meaning.'
};

const TOOL_PROMPTS = {
  'summarize-page':'Summarize the attached page clearly. Preserve important facts and structure.',
  'key-points':'Extract the most important key points from the attached page as a concise structured list.',
  'explain-page':'Explain the attached page in simple, clear language. Clarify difficult terms when needed.',
  'translate-page':'Translate the important content of the attached page into Hebrew, preserving meaning and structure.',
  'ask-page':''
};

const COMMANDS = [
  ['שיחה חדשה', () => createNewChat()],
  ['סכם את העמוד', () => runPageTool('summarize-page')],
  ['הסבר את העמוד', () => runPageTool('explain-page')],
  ['נקודות מפתח מהעמוד', () => runPageTool('key-points')],
  ['צרף את העמוד', () => attachPage(false)],
  ['צרף טקסט מסומן', () => attachPage(true)],
  ['צרף קובץ', () => els.fileInput.click()],
  ['צרף צילום מסך', () => captureScreen()],
  ['פתח הגדרות', () => els.settingsDialog.showModal()],
  ['אבחון מערכת', () => openDiagnostics()],
  ['ייצוא שיחה', () => exportChat()]
];

let chats = [];
let activeChatId = null;
let settings = {...DEFAULT_SETTINGS};
let modelSession = null;
let modelSessionChatId = null;
let modelSessionMultimodal = false;
let translatorHeEn = null;
let translatorEnHe = null;
let intentNormalizerSession = null;
let busy = false;
let abortController = null;
let pageContext = null;
let pendingAttachments = [];
let modelAvailability = 'unknown';
let lastLanguageDebug = null;

function uid(){return crypto.randomUUID?.() || Date.now().toString(36)+Math.random().toString(36).slice(2)}
function now(){return Date.now()}
function activeChat(){return chats.find(c=>c.id===activeChatId)||null}
function containsHebrew(t){return /[\u0590-\u05FF]/.test(t||'')}
function normalizeWords(t){return (t||'').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]}
function setStatus(t,type=''){els.status.textContent=t;els.status.className='status'+(type?' '+type:'')}
function showNotice(t){els.notice.textContent=t;els.notice.classList.remove('hidden')}
function hideNotice(){els.notice.classList.add('hidden')}
function toast(message,type=''){
  if(!els.toastHost)return;
  const node=document.createElement('div');
  node.className='toast'+(type?' '+type:'');
  node.textContent=message;
  els.toastHost.appendChild(node);
  setTimeout(()=>node.remove(),3200);
}
function formatTime(ts){const d=new Date(ts),today=new Date();return d.toDateString()===today.toDateString()?d.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString('he-IL',{day:'2-digit',month:'2-digit'})}
async function persist(){await chrome.storage.local.set({nanoChats:chats,nanoActiveChatId:activeChatId,nanoSettings:settings})}
function newChatData(){return{id:uid(),title:'שיחה חדשה',createdAt:now(),updatedAt:now(),messages:[],pinned:false,folder:''}}

function resetSession(){
  try{modelSession?.destroy?.()}catch{}
  try{intentNormalizerSession?.destroy?.()}catch{}
  modelSession=null;
  modelSessionChatId=null;
  modelSessionMultimodal=false;
  intentNormalizerSession=null;
}
async function createNewChat(){resetSession();const c=newChatData();chats.unshift(c);activeChatId=c.id;pageContext=null;pendingAttachments=[];renderAll();await persist();els.prompt.focus()}

function chatTimeGroup(ts){
  const d=new Date(ts), nowDate=new Date();
  const today=new Date(nowDate.getFullYear(),nowDate.getMonth(),nowDate.getDate());
  const target=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const diff=Math.round((today-target)/86400000);
  if(diff===0)return 'היום';
  if(diff===1)return 'אתמול';
  if(diff<7)return 'השבוע';
  return 'ישן יותר';
}
function renderChatList(){
  const q=els.chatSearch.value.trim().toLowerCase(), folder=els.folderFilter.value;
  els.chatList.innerHTML='';
  const filtered=chats.filter(c=>(!q||c.title.toLowerCase().includes(q)||c.messages.some(m=>(m.text||'').toLowerCase().includes(q)))&&(!folder||(folder==='מועדפים'?c.pinned:c.folder===folder)));
  filtered.sort((a,b)=>(b.pinned-a.pinned)||(b.updatedAt-a.updatedAt));
  let lastGroup='';
  for(const chat of filtered){
    const group=chat.pinned?'מועדפים':chatTimeGroup(chat.updatedAt);
    if(group!==lastGroup){
      const label=document.createElement('div');label.className='chat-group-label';label.textContent=group;els.chatList.appendChild(label);lastGroup=group;
    }
    const wrap=document.createElement('div');wrap.className='chat-item-wrap'+(chat.id===activeChatId?' active':'');
    const btn=document.createElement('button');btn.className='chat-item';
    const title=document.createElement('strong');title.textContent=chat.title;
    const meta=document.createElement('small');meta.textContent=formatTime(chat.updatedAt)+' • '+chat.messages.length+' הודעות'+(chat.folder?' • '+chat.folder:'');
    btn.append(title,meta);btn.addEventListener('click',async()=>{activeChatId=chat.id;pageContext=null;pendingAttachments=[];resetSession();renderAll();await persist();if(innerWidth<520)els.sidebar.classList.add('collapsed')});
    const acts=document.createElement('div');acts.className='chat-actions';
    const star=document.createElement('button');star.textContent=chat.pinned?'★':'☆';star.title='מועדף';star.addEventListener('click',async e=>{e.stopPropagation();chat.pinned=!chat.pinned;renderChatList();await persist()});
    const del=document.createElement('button');del.textContent='×';del.title='מחק שיחה';del.addEventListener('click',async e=>{e.stopPropagation();chats=chats.filter(c=>c.id!==chat.id);if(!chats.length)chats=[newChatData()];if(activeChatId===chat.id)activeChatId=chats[0].id;resetSession();renderAll();await persist();toast('השיחה נמחקה')});
    acts.append(star,del);wrap.append(btn,acts);els.chatList.appendChild(wrap);
  }
  if(!filtered.length){const empty=document.createElement('div');empty.className='chat-group-label';empty.textContent='לא נמצאו שיחות';els.chatList.appendChild(empty)}
}

function addMessageActions(actions,message,index){
  const copy=document.createElement('button');copy.textContent='העתק';copy.onclick=()=>navigator.clipboard.writeText(message.text||'');actions.append(copy);
  if(message.role==='user'){
    const reuse=document.createElement('button');reuse.textContent='השתמש שוב';reuse.onclick=()=>{els.prompt.value=message.text;autoResize();updateCounter();els.prompt.focus()};actions.append(reuse);
  } else {
    const regen=document.createElement('button');regen.textContent='נסה שוב';regen.onclick=()=>regenerate(index);actions.append(regen);
    const shorter=document.createElement('button');shorter.textContent='קצר יותר';shorter.onclick=()=>transformAnswer(index,'Rewrite the previous answer to be substantially shorter while preserving the key points.');actions.append(shorter);
    const longer=document.createElement('button');longer.textContent='פרט יותר';longer.onclick=()=>transformAnswer(index,'Expand the previous answer with useful detail, explanation, and structure without adding unsupported facts.');actions.append(longer);
  }
  const del=document.createElement('button');del.textContent='מחק';del.onclick=async()=>{const c=activeChat();c.messages.splice(index,1);c.updatedAt=now();resetSession();renderMessages();renderChatList();await persist()};actions.append(del);
}
function escapeHtml(text){return (text||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renderMarkdown(text){
  let s=escapeHtml(text||'');
  s=s.replace(/```([\s\S]*?)```/g,(_,code)=>'<pre><code>'+code.trim()+'</code></pre>');
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
  s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>');
  s=s.replace(/^[-*] (.+)$/gm,'<li>$1</li>');
  s=s.replace(/(?:<li>.*<\/li>\n?)+/g,m=>'<ul>'+m+'</ul>');
  s=s.replace(/^\d+\. (.+)$/gm,'<li>$1</li>');
  s=s.replace(/(?:<li>.*<\/li>\n?)+/g,m=>m.startsWith('<ul>')?m:'<ol>'+m+'</ol>');
  s=s.replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>');
  return '<p>'+s+'</p>';
}
function messageNode(message,index){
  const row=document.createElement('div');row.className='message '+message.role;
  const wrap=document.createElement('div');wrap.className='message-wrap';
  const bubble=document.createElement('div');bubble.className='bubble';bubble.innerHTML=renderMarkdown(message.text||'');
  const actions=document.createElement('div');actions.className='message-actions';addMessageActions(actions,message,index);
  wrap.append(bubble,actions);row.append(wrap);return{row,bubble}
}
function renderMessages(){
  const c=activeChat();els.messages.innerHTML='';const has=!!c?.messages.length;els.welcome.classList.toggle('hidden',has);els.messages.classList.toggle('hidden',!has);if(!c)return;
  c.messages.forEach((m,i)=>els.messages.appendChild(messageNode(m,i).row));els.messages.scrollTop=els.messages.scrollHeight;els.chatTitle.value=c.title
}
function renderAttachments(){
  els.attachments.innerHTML='';els.attachments.classList.toggle('hidden',!pendingAttachments.length);
  pendingAttachments.forEach((a,i)=>{const chip=document.createElement('div');chip.className='attachment';chip.textContent=(a.kind==='image'?'🖼 ':'📄 ')+a.name;const x=document.createElement('button');x.textContent='×';x.onclick=()=>{pendingAttachments.splice(i,1);renderAttachments()};chip.append(x);els.attachments.append(chip)})
}
function renderContext(){
  if(!pageContext){els.contextChip.classList.add('hidden');return}
  els.contextChip.classList.remove('hidden');els.contextLabel.textContent=pageContext.selection?'טקסט מסומן מצורף':'עמוד מצורף: '+(pageContext.title||'ללא כותרת');els.livePage.checked=!!pageContext.live
}
function renderAll(){renderChatList();renderMessages();renderAttachments();renderContext();updateContextMeter()}

function styleInstruction(){return{concise:'Keep the answer concise and direct.',balanced:'Give a balanced answer with enough explanation to be useful.',detailed:'Give a detailed, structured answer with useful explanation.'}[settings.responseStyle]||''}
function systemInstruction(){return settings.systemPrompt+'\n'+(PROFILE_PROMPTS[settings.profile]||PROFILE_PROMPTS.general)+'\n'+styleInstruction()}

function translatorOptions(sourceLanguage,targetLanguage){return{sourceLanguage,targetLanguage,monitor(m){m.addEventListener('downloadprogress',e=>{const p=Math.round(e.loaded*100);els.downloadBox.classList.remove('hidden');els.downloadProgress.value=p;els.downloadPercent.textContent=p+'%';setStatus('מוריד תרגום '+p+'%','warn')})}}}
async function getTranslator(from,to){
  if(!('Translator'in self))throw new Error('Translator API אינו זמין.');
  if(from==='he'&&to==='en'&&translatorHeEn)return translatorHeEn;if(from==='en'&&to==='he'&&translatorEnHe)return translatorEnHe;
  const a=await Translator.availability({sourceLanguage:from,targetLanguage:to});
  if(a==='unavailable')throw new Error('חבילת התרגום '+from+'→'+to+' אינה זמינה.');
  if((a==='downloadable'||a==='downloading')&&!navigator.userActivation.isActive){els.setupBox.classList.remove('hidden');throw new Error('חבילת התרגום עדיין לא מוכנה. לחץ "הכן AI מקומי".')}
  const t=await Translator.create(translatorOptions(from,to));if(from==='he'&&to==='en')translatorHeEn=t;if(from==='en'&&to==='he')translatorEnHe=t;return t
}
function splitTranslationText(text,maxChars=3000){
  const paragraphs=(text||'').split(/\n{2,}/);
  const chunks=[];
  let current='';
  for(const p of paragraphs){
    const candidate=current ? current+'\n\n'+p : p;
    if(candidate.length<=maxChars){current=candidate;continue}
    if(current)chunks.push(current);
    if(p.length<=maxChars){current=p;continue}
    for(let i=0;i<p.length;i+=maxChars)chunks.push(p.slice(i,i+maxChars));
    current='';
  }
  if(current)chunks.push(current);
  return chunks.filter(Boolean);
}

async function translateText(text,from,to,onChunk){
  const t=await getTranslator(from,to);
  const chunks=splitTranslationText(text,3000);
  let out='';
  for(let i=0;i<chunks.length;i++){
    const translated=await t.translate(chunks[i]);
    out += (out ? '\n\n' : '') + translated;
    onChunk?.(out);
  }
  return out;
}

function languageModelOptions(multimodal=false){
  const options={expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]};
  if(multimodal)options.expectedInputs.push({type:'image'});return options
}
function healthyModelText(message){
  const text=(message?.modelText||'').trim();
  if(!text)return false;
  if(message.role==='assistant'){
    if(text.length<3 || /^[\s\p{P}\p{S}]+$/u.test(text))return false;
    const hebrew=(text.match(/[\u0590-\u05FF]/g)||[]).length;
    if(hebrew > Math.max(4,text.length*0.08))return false;
    if(/(.)\1{7,}/u.test(text))return false;
  }
  return true;
}

async function makeInitialPrompts(chat){
  const prompts=[{role:'system',content:systemInstruction()}];
  const recent=chat.messages.slice(-12);
  for(const m of recent){
    if(!healthyModelText(m))continue;
    prompts.push({role:m.role==='assistant'?'assistant':'user',content:m.modelText.slice(0,7000)})
  }
  return prompts
}
async function ensureSession(multimodal=false){
  const chat=activeChat();if(!chat)throw new Error('אין שיחה פעילה.');
  if(modelSession&&modelSessionChatId===chat.id&&(!multimodal||modelSessionMultimodal))return modelSession;
  resetSession();
  if(!('LanguageModel'in self))throw new Error('Prompt API לא זמין. נדרש Chrome 138 ומעלה.');
  const options=languageModelOptions(multimodal), availability=await LanguageModel.availability(options);modelAvailability=availability;
  if(availability==='unavailable')throw new Error(multimodal?'המודל הרב-מודאלי אינו זמין ב-Chrome הזה.':'Gemini Nano אינו זמין במכשיר הזה.');
  if((availability==='downloadable'||availability==='downloading')&&!navigator.userActivation.isActive){els.setupBox.classList.remove('hidden');throw new Error('Gemini Nano עדיין לא מוכן. לחץ "הכן AI מקומי".')}
  const createOptions={...options,initialPrompts:await makeInitialPrompts(chat),monitor(m){m.addEventListener('downloadprogress',e=>{const p=Math.round(e.loaded*100);els.downloadBox.classList.remove('hidden');els.downloadProgress.value=p;els.downloadPercent.textContent=p+'%';setStatus('מוריד Gemini Nano '+p+'%','warn')})}};
  try{const params=await LanguageModel.params?.();if(params){createOptions.temperature=Math.min(Number(settings.temperature)||0.8,params.maxTemperature??2);createOptions.topK=Math.min(Number(settings.topK)||8,params.maxTopK??40)}}catch{}
  modelSession=await LanguageModel.create(createOptions);modelSessionChatId=chat.id;modelSessionMultimodal=multimodal;setStatus('מוכן • מקומי','ok');updateContextMeter();return modelSession
}

async function prepareLocalAI(){
  hideNotice();if(!('LanguageModel'in self)){showNotice('Prompt API אינו קיים ב-Chrome הזה.');return}
  els.prepareAiBtn.disabled=true;els.setupBox.classList.remove('hidden');els.downloadBox.classList.remove('hidden');setStatus('מכין AI מקומי...','warn');
  try{
    const pModel=LanguageModel.create({...languageModelOptions(false),initialPrompts:[{role:'system',content:systemInstruction()}],monitor(m){m.addEventListener('downloadprogress',e=>{const p=Math.round(e.loaded*100);els.downloadProgress.value=p;els.downloadPercent.textContent=p+'%';setStatus('מוריד Gemini Nano '+p+'%','warn')})}});
    const p1='Translator'in self?Translator.create(translatorOptions('he','en')):Promise.resolve(null),p2='Translator'in self?Translator.create(translatorOptions('en','he')):Promise.resolve(null);
    const [model,t1,t2]=await Promise.all([pModel,p1,p2]);resetSession();modelSession=model;modelSessionChatId=activeChatId;translatorHeEn=t1;translatorEnHe=t2;els.setupBox.classList.add('hidden');els.downloadBox.classList.add('hidden');setStatus('מוכן • מקומי','ok');toast('ה-AI המקומי מוכן','success');setTimeout(hideNotice,1800)
  }catch(e){setStatus('הכנה נכשלה','error');showNotice('הכנת ה-AI נכשלה: '+(e.message||e))}
  finally{els.prepareAiBtn.disabled=false}
}

function splitChunks(text,size=3200,overlap=280){const out=[];let i=0;while(i<text.length){out.push(text.slice(i,i+size));i+=Math.max(1,size-overlap)}return out}
function scoreChunk(chunk,query){const q=new Set(normalizeWords(query));if(!q.size)return 0;const words=normalizeWords(chunk);let score=0;for(const w of words)if(q.has(w))score++;return score/Math.sqrt(Math.max(1,words.length))}
function relevantContext(text,query,maxChars=9000){
  if(!settings.smartContext||text.length<=maxChars)return text.slice(0,maxChars);
  const chunks=splitChunks(text,2600,220).map((t,i)=>({t,i,s:scoreChunk(t,query)}));chunks.sort((a,b)=>b.s-a.s||a.i-b.i);
  return chunks.slice(0,4).sort((a,b)=>a.i-b.i).map(x=>x.t).join('\n\n[…קטע נוסף…]\n\n').slice(0,maxChars)
}
async function extractPage(selectionOnly=false){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!/^https?:/i.test(tab.url||''))throw new Error('לא ניתן לקרוא את העמוד הזה.');
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:(onlySelection)=>{const selected=window.getSelection()?.toString().trim()||'';if(onlySelection)return{selection:true,title:document.title,url:location.href,text:selected};
    const clone=document.body.cloneNode(true);clone.querySelectorAll('script,style,noscript,svg,canvas,nav,footer,form,aside').forEach(n=>n.remove());const text=(clone.innerText||'').replace(/\n{3,}/g,'\n\n').trim();return{selection:false,title:document.title,url:location.href,text}},args:[selectionOnly]});
  if(!result?.text)throw new Error(selectionOnly?'לא נמצא טקסט מסומן.':'לא נמצא טקסט קריא בעמוד.');return result
}
async function attachPage(selectionOnly=false){hideNotice();setStatus('קורא עמוד...','warn');try{const oldLive=pageContext?.live||false;pageContext=await extractPage(selectionOnly);pageContext.live=oldLive&&!selectionOnly;renderContext();setStatus('מוכן • מקומי','ok')}catch(e){setStatus('שגיאה','error');showNotice(e.message)}}
async function refreshLivePage(){if(pageContext?.live&&!pageContext.selection){const live=true;pageContext=await extractPage(false);pageContext.live=live;renderContext()}}

async function readFiles(files){
  for(const file of files){
    if(file.type.startsWith('image/'))pendingAttachments.push({id:uid(),kind:'image',name:file.name,blob:file});
    else{const text=await file.text();pendingAttachments.push({id:uid(),kind:'text',name:file.name,text:text.slice(0,200000)})}
  }
  renderAttachments()
}
async function captureScreen(){
  try{const dataUrl=await chrome.tabs.captureVisibleTab();const blob=await(await fetch(dataUrl)).blob();pendingAttachments.push({id:uid(),kind:'image',name:'צילום מסך',blob});renderAttachments()}
  catch(e){showNotice('לא ניתן לצלם את הטאב: '+(e.message||e))}
}
function buildTextContext(userText){
  const blocks=[];
  if(pageContext){blocks.push('PAGE CONTEXT\nTitle: '+pageContext.title+'\nURL: '+pageContext.url+'\nContent:\n'+relevantContext(pageContext.text,userText))}
  for(const a of pendingAttachments.filter(x=>x.kind==='text'))blocks.push('FILE: '+a.name+'\n'+relevantContext(a.text,userText));
  return blocks.length?userText+'\n\n'+blocks.join('\n\n---\n\n'):userText
}
async function getIntentNormalizer(){
  if(intentNormalizerSession)return intentNormalizerSession;
  if(!('LanguageModel' in self))return null;

  const options=languageModelOptions(false);
  const availability=await LanguageModel.availability(options);
  if(availability!=='available')return null;

  const createOptions={
    ...options,
    initialPrompts:[{
      role:'system',
      content:[
        'You normalize machine-translated user requests before another assistant answers them.',
        'Rewrite the supplied English translation into natural, unambiguous English that preserves the user\'s likely intent.',
        'Preserve the requested action, requested amount or length, output format, constraints, negations, tone, and whether the user is asking for content versus asking to evaluate something.',
        'Do not answer the request. Do not add new requirements. Do not explain your work.',
        'Return only the normalized request.'
      ].join(' ')
    }]
  };

  try{
    const params=await LanguageModel.params?.();
    if(params){
      createOptions.temperature=Math.min(0.2,params.maxTemperature??0.2);
      createOptions.topK=Math.min(4,params.maxTopK??4);
    }
  }catch{}

  intentNormalizerSession=await LanguageModel.create(createOptions);
  return intentNormalizerSession;
}

function hebrewPhraseWindows(text){
  const words=(text||'').trim().split(/\s+/).filter(Boolean);
  const windows=[];
  if(words.length<=1)return windows;

  const maxWindow=words.length<=8 ? 3 : 4;
  for(let size=2;size<=maxWindow;size++){
    for(let i=0;i+size<=words.length;i++){
      windows.push(words.slice(i,i+size).join(' '));
      if(windows.length>=10)return windows;
    }
  }
  return windows;
}

async function pivotTranslateToEnglish(text,pivotLanguage){
  if(!('Translator' in self))return null;

  const firstPair={sourceLanguage:'he',targetLanguage:pivotLanguage};
  const secondPair={sourceLanguage:pivotLanguage,targetLanguage:'en'};

  try{
    const [a1,a2]=await Promise.all([
      Translator.availability(firstPair),
      Translator.availability(secondPair)
    ]);

    if(a1==='unavailable' || a2==='unavailable')return null;

    // Do not trigger surprise downloads from background normalization.
    if(a1!=='available' || a2!=='available')return null;

    const t1=await Translator.create(firstPair);
    const t2=await Translator.create(secondPair);
    try{
      const pivot=await t1.translate(text);
      return (await t2.translate(pivot)).trim();
    }finally{
      t1.destroy?.();
      t2.destroy?.();
    }
  }catch(error){
    console.warn('Pivot translation failed:',pivotLanguage,error);
    return null;
  }
}

async function buildIntentEvidence(originalHebrew){
  const clean=(originalHebrew||'').trim();
  if(!clean || !containsHebrew(clean))return [];

  const evidence=[];
  const seen=new Set();

  const addDirect=async(label,source)=>{
    const key=source.trim();
    if(!key || seen.has('direct:'+key))return;
    seen.add('direct:'+key);
    try{
      const translated=(await translateText(key,'he','en')).trim();
      if(translated)evidence.push({label,source:key,translated});
    }catch(error){
      console.warn('Intent evidence translation failed:',label,error);
    }
  };

  await addDirect('full-direct',clean);

  // Independent semantic views through languages the Prompt API understands well.
  for(const pivot of ['de','es','fr']){
    const translated=await pivotTranslateToEnglish(clean,pivot);
    if(translated && !seen.has('pivot:'+translated)){
      seen.add('pivot:'+translated);
      evidence.push({label:'full-via-'+pivot,source:clean,translated});
    }
  }

  const clauseParts=clean
    .split(/[,.!?;:\n]+|\s+(?:אבל|אך|וגם|ואז|כדי|בשביל|רק)\s+/)
    .map(x=>x.trim())
    .filter(x=>x.length>=2);

  for(const part of clauseParts.slice(0,4))await addDirect('clause',part);
  for(const phrase of hebrewPhraseWindows(clean).slice(0,6))await addDirect('phrase',phrase);

  return evidence;
}

async function normalizeTranslatedIntent(machineTranslation,originalHebrew){
  const clean=(machineTranslation||'').trim();
  if(!clean)return clean;

  try{
    const normalizer=await getIntentNormalizer();
    if(!normalizer)return clean;

    const evidence=await buildIntentEvidence(originalHebrew);
    const evidenceText=evidence.length
      ? evidence.map((e,i)=>`View ${i+1} [${e.label}]: ${e.translated}`).join('\n')
      : '(no extra views available)';

    const normalized=(await normalizer.prompt(
      [
        'A Hebrew user request was translated into English through several independent routes. Any one route may contain lexical ambiguity or a misleading word choice.',
        'Infer the most likely intended user request from ALL translation views below.',
        'Treat agreement across independent full-request routes as stronger evidence than a single ambiguous wording.',
        'Use shorter phrase/clause views only to resolve ambiguity, not to invent a new task.',
        'Preserve requested action, quantity, length, format, constraints, negation, and tone.',
        'Do not answer the request. Do not explain your reasoning. Return only one normalized English request.',
        '',
        'FULL MACHINE TRANSLATION:',
        clean,
        '',
        'ADDITIONAL TRANSLATION VIEWS:',
        evidenceText
      ].join('\n')
    )).trim();

    if(!normalized || normalized.length>Math.max(12000,clean.length*2.5))return clean;
    return normalized;
  }catch(error){
    console.warn('Intent normalization fallback:',error);
    return clean;
  }
}

async function normalizeInput(text,userQuestion){
  const wantsHebrew=settings.answerLanguage==='he'||(settings.answerLanguage==='auto'&&containsHebrew(userQuestion));
  let modelText=text;

  if(containsHebrew(text)){
    setStatus('מתרגם קלט...','warn');
    const machineTranslation=await translateText(text,'he','en');

    setStatus('משמר כוונה...','warn');
    const evidence=await buildIntentEvidence(userQuestion);
    modelText=await normalizeTranslatedIntent(machineTranslation,userQuestion);
    lastLanguageDebug={
      original:userQuestion,
      direct:machineTranslation,
      evidence,
      normalized:modelText,
      at:Date.now()
    };
  }

  return{
    modelText:modelText+(wantsHebrew?'\nAnswer in English first; the app will translate the final answer to Hebrew.':'\nAnswer in English.'),
    wantsHebrew
  };
}
function buildMultimodalPrompt(modelText){
  const images=pendingAttachments.filter(x=>x.kind==='image');if(!images.length)return modelText;
  return[{role:'user',content:[{type:'text',value:modelText},...images.map(a=>({type:'image',value:a.blob}))]}]
}
function updateContextMeter(){
  if(modelSession&&typeof modelSession.contextUsage==='number'&&typeof modelSession.contextWindow==='number'){
    const pct=Math.round(modelSession.contextUsage/modelSession.contextWindow*100);
    els.contextMeter.textContent='Context: '+pct+'%';
    els.contextMeter.classList.toggle('warn',pct>78);
    return;
  }
  const c=activeChat();const chars=(c?.messages||[]).reduce((n,m)=>n+(m.modelText||m.text||'').length,0)+(pageContext?.text?.length||0);els.contextMeter.textContent='Context: ~'+Math.round(chars/4000)+'k';els.contextMeter.classList.toggle('warn',chars>30000)
}
async function recoverSession(multimodal=false){const c=activeChat();if(c?.messages.length>10)c.messages=c.messages.slice(-10);resetSession();return ensureSession(multimodal)}

async function generateAnswer(userText,{replaceIndex=null,internalPrompt=null}={}){
  if(busy)return;const c=activeChat();if(!c)return;hideNotice();busy=true;abortController=new AbortController();els.sendBtn.disabled=true;els.stopBtn.classList.remove('hidden');
  try{
    await refreshLivePage();
    let displayUser=userText;
    if(replaceIndex===null){c.messages.push({role:'user',text:displayUser,modelText:null,at:now()});c.updatedAt=now();if(settings.autoTitle&&c.messages.length===1&&c.title==='שיחה חדשה')c.title=displayUser.replace(/\s+/g,' ').slice(0,42)||'שיחה חדשה'}
    els.prompt.value='';autoResize();updateCounter();renderAll();

    const fullInput=buildTextContext(internalPrompt||userText), normalized=await normalizeInput(fullInput,userText), images=pendingAttachments.some(x=>x.kind==='image');
    const userMsg=replaceIndex===null?c.messages[c.messages.length-1]:null;if(userMsg)userMsg.modelText=normalized.modelText;
    let placeholder;
    if(replaceIndex!==null){placeholder=c.messages[replaceIndex];placeholder.text='';placeholder.modelText=''}
    else{placeholder={role:'assistant',text:'',modelText:'',at:now()};c.messages.push(placeholder);replaceIndex=c.messages.length-1}
    renderMessages();const bubble=els.messages.lastElementChild?.querySelector('.bubble');if(bubble){bubble.classList.add('typing');bubble.innerHTML='<span class="typing-dots"><i></i><i></i><i></i></span>'}

    let model;try{model=await ensureSession(images)}catch(e){throw e}
    setStatus('חושב...','warn');
    let english='';const payload=buildMultimodalPrompt(normalized.modelText);
    const stream=model.promptStreaming(payload,{signal:abortController.signal});
    for await(const chunk of stream){
      english += chunk;
      placeholder.modelText=english;
      if(!normalized.wantsHebrew){
        placeholder.text=english;
        if(bubble)bubble.innerHTML=renderMarkdown(english);
        updateContextMeter();
      }
    }
    if(normalized.wantsHebrew){setStatus('מתרגם תשובה...','warn');placeholder.text=await translateText(english,'en','he',out=>{if(bubble)bubble.innerHTML=renderMarkdown(out)})}else placeholder.text=english;
    bubble?.classList.remove('typing');setStatus('מוכן • מקומי','ok');pendingAttachments=[];renderAttachments();updateContextMeter()
  }catch(e){
    if(e?.name==='AbortError'){setStatus('הופסק','warn')}
    else if(/context|quota|overflow/i.test(e?.message||'')){showNotice('חלון ההקשר התמלא. אני מצמצם את ההיסטוריה ומנסה שוב.');try{await recoverSession(pendingAttachments.some(x=>x.kind==='image'));busy=false;els.sendBtn.disabled=false;els.stopBtn.classList.add('hidden');return generateAnswer(userText,{replaceIndex,internalPrompt})}catch(e2){showNotice('שחזור נכשל: '+(e2.message||e2))}}
    else{setStatus('שגיאה','error');showNotice(e?.message||String(e))}
  }finally{const c2=activeChat();if(c2)c2.updatedAt=now();busy=false;abortController=null;els.sendBtn.disabled=false;els.stopBtn.classList.add('hidden');renderAll();await persist();els.prompt.focus()}
}
async function sendPrompt(text){text=text.trim();if(text)await generateAnswer(text)}
async function regenerate(index){const c=activeChat();const prev=[...c.messages.slice(0,index)].reverse().find(m=>m.role==='user');if(!prev)return;c.messages.splice(index,1);resetSession();await generateAnswer(prev.text)}
async function transformAnswer(index,instruction){const c=activeChat();const target=c.messages[index];if(!target)return;await generateAnswer('שפר את התשובה הקודמת',{replaceIndex:index,internalPrompt:instruction+'\n\nPrevious answer:\n'+(target.modelText||target.text)})}

async function hierarchicalSummary(text){
  const chunks=splitChunks(text,6000,200);if(chunks.length<=2)return null;
  setStatus('מסכם '+chunks.length+' חלקים...','warn');const model=await ensureSession(false);const parts=[];
  for(let i=0;i<chunks.length;i++){let t=chunks[i];if(containsHebrew(t))t=await translateText(t,'he','en');parts.push(await model.prompt('Summarize this section faithfully in compact bullet points:\n\n'+t));setStatus('מסכם חלק '+(i+1)+'/'+chunks.length,'warn')}
  return 'Create one coherent summary from these section summaries. Remove duplication and preserve important facts:\n\n'+parts.join('\n\n---\n\n')
}
async function runPageTool(tool){
  els.toolsMenu.classList.add('hidden');await attachPage(false);if(!pageContext)return;
  if(tool==='ask-page'){els.prompt.placeholder='שאל משהו על העמוד המצורף...';els.prompt.focus();return}
  let prompt=TOOL_PROMPTS[tool]||'Analyze the attached page.';
  if(tool==='summarize-page'){const hierarchical=await hierarchicalSummary(pageContext.text);if(hierarchical){await generateAnswer('סכם את העמוד',{internalPrompt:hierarchical});return}}
  await generateAnswer(prompt)
}

async function checkAvailability(){
  if(!('LanguageModel'in self)){setStatus('לא נתמך','error');showNotice('Prompt API לא נמצא.');return}
  try{const a=await LanguageModel.availability(languageModelOptions(false));modelAvailability=a;const map={available:['מוכן • מקומי','ok'],downloadable:['מוכן להורדה','warn'],downloading:['בהורדה','warn'],unavailable:['לא זמין','error']};const [label,type]=map[a]||[a,''];setStatus(label,type);if(a==='downloadable'||a==='downloading'){els.setupBox.classList.remove('hidden');els.setupDetail.textContent='Chrome עדיין צריך להכין את רכיבי ה-AI המקומיים.'}else if(a==='available')els.setupBox.classList.add('hidden')}catch(e){setStatus('שגיאה','error');showNotice(e.message)}
}
async function collectDiagnostics(){
  const rows=[],add=(name,value)=>rows.push({name,value});add('Chrome',navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1]||'לא זוהה');add('מערכת',navigator.platform||'לא ידוע');add('Prompt API','LanguageModel'in self?'קיים':'חסר');add('Translator API','Translator'in self?'קיים':'חסר');
  if('LanguageModel'in self){for(const [name,multi] of [['Gemini Nano',false],['Multimodal',true]])try{add(name,await LanguageModel.availability(languageModelOptions(multi)))}catch(e){add(name,'שגיאה: '+(e.message||e))}try{const p=await LanguageModel.params?.();if(p)add('Model params','topK≤'+p.maxTopK+', temp≤'+p.maxTemperature)}catch{}}
  if('Translator'in self)for(const [f,t] of [['he','en'],['en','he']])try{add('תרגום '+f+'→'+t,await Translator.availability({sourceLanguage:f,targetLanguage:t}))}catch(e){add('תרגום '+f+'→'+t,'שגיאה')}
  add('User activation',navigator.userActivation?.isActive?'פעיל':'לא פעיל');return rows
}
async function renderDiagnostics(){els.diagnosticsContent.textContent='בודק...';const rows=await collectDiagnostics();els.diagnosticsContent.innerHTML='';for(const r of rows){const d=document.createElement('div');d.className='diag-row';const a=document.createElement('strong');a.textContent=r.name;const b=document.createElement('span');b.textContent=r.value;d.append(a,b);els.diagnosticsContent.append(d)}const help=document.createElement('div');help.className='diag-help';help.textContent='אם המודל נשאר unavailable או שהורדה נכשלת, בדוק chrome://on-device-internals → Model Status. ודא גם שיש מקום פנוי בדיסק.';els.diagnosticsContent.append(help)}
async function openDiagnostics(){els.diagnosticsDialog.showModal();await renderDiagnostics()}
async function runSelfTest(){
  els.runSelfTest.disabled=true;try{setStatus('בדיקת קצה-לקצה...','warn');const model=await ensureSession(false);const input=await translateText('בדיקה מקומית קצרה','he','en');const out=await model.prompt(input+' Reply only with: LOCAL_OK');const he=await translateText(out,'en','he');showNotice('בדיקה הצליחה: '+he);setStatus('בדיקה עברה','ok')}catch(e){showNotice('בדיקה נכשלה: '+(e.message||e));setStatus('בדיקה נכשלה','error')}finally{els.runSelfTest.disabled=false}
}

function renderLanguageDebug(){
  if(!els.languageDebugContent)return;
  els.languageDebugContent.innerHTML='';
  if(!lastLanguageDebug){
    const empty=document.createElement('div');empty.className='diag-help';empty.textContent='עדיין אין אבחון. שלח הודעה בעברית ואז פתח שוב.';els.languageDebugContent.appendChild(empty);return;
  }
  const steps=[
    ['הטקסט המקורי',lastLanguageDebug.original],
    ['תרגום ישיר',lastLanguageDebug.direct],
    ...((lastLanguageDebug.evidence||[]).map(e=>['תרגום '+e.label,e.translated])),
    ['בקשה מנורמלת למודל',lastLanguageDebug.normalized]
  ];
  for(const [title,value] of steps){
    const box=document.createElement('div');box.className='debug-step';
    const h=document.createElement('strong');h.textContent=title;
    const pre=document.createElement('pre');pre.textContent=value||'—';
    box.append(h,pre);els.languageDebugContent.appendChild(box);
  }
}
function languageDebugText(){
  if(!lastLanguageDebug)return '';
  return [
    'ORIGINAL:\n'+lastLanguageDebug.original,
    'DIRECT:\n'+lastLanguageDebug.direct,
    ...((lastLanguageDebug.evidence||[]).map(e=>e.label.toUpperCase()+':\n'+e.translated)),
    'NORMALIZED:\n'+lastLanguageDebug.normalized
  ].join('\n\n---\n\n');
}
function autoResize(){els.prompt.style.height='auto';els.prompt.style.height=Math.min(150,els.prompt.scrollHeight)+'px'}
function updateCounter(){els.counter.textContent=els.prompt.value.length.toLocaleString('he-IL')}
async function exportChat(){const c=activeChat();if(!c)return;const lines=['# '+c.title,'','נוצר באמצעות Gemini Nano Local Workspace',''];for(const m of c.messages)lines.push(m.role==='user'?'## אתה':'## Gemini Nano','',m.text,'');const blob=new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(c.title||'gemini-nano-chat').replace(/[\\/:*?"<>|]/g,'-')+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function openPalette(){els.paletteSearch.value='';renderPalette();els.paletteDialog.showModal();setTimeout(()=>els.paletteSearch.focus(),20)}
function renderPalette(){const q=els.paletteSearch.value.trim().toLowerCase();els.paletteList.innerHTML='';for(const [name,fn] of COMMANDS.filter(([n])=>n.toLowerCase().includes(q))){const b=document.createElement('button');b.textContent=name;b.onclick=()=>{els.paletteDialog.close();fn()};els.paletteList.append(b)}}

async function loadState(){
  const data=await chrome.storage.local.get(['nanoChats','nanoActiveChatId','nanoSettings']);chats=Array.isArray(data.nanoChats)?data.nanoChats:[];settings={...DEFAULT_SETTINGS,...(data.nanoSettings||{})};
  if(!data.nanoSettings?.qualityTuned){
    settings.temperature=Math.min(Number(settings.temperature)||0.5,0.5);
    settings.topK=Math.min(Number(settings.topK)||6,6);
    settings.qualityTuned=true;
  }
  if(!chats.length)chats=[newChatData()];activeChatId=chats.some(c=>c.id===data.nanoActiveChatId)?data.nanoActiveChatId:chats[0].id;
  for(const c of chats){c.pinned=!!c.pinned;c.folder=c.folder||'';c.messages=c.messages||[]}
  els.profile.value=settings.profile;els.responseStyle.value=settings.responseStyle;els.answerLanguage.value=settings.answerLanguage;els.temperature.value=settings.temperature;els.temperatureValue.textContent=settings.temperature;els.topK.value=settings.topK;els.topKValue.textContent=settings.topK;els.systemPrompt.value=settings.systemPrompt;els.autoTitle.checked=settings.autoTitle;els.smartContext.checked=settings.smartContext;renderAll();await persist()
}
async function consumePending(){const {nanoPendingPrompt,nanoCommand}=await chrome.storage.local.get(['nanoPendingPrompt','nanoCommand']);if(nanoCommand?.type==='new-chat'){await chrome.storage.local.remove('nanoCommand');await createNewChat()}if(nanoPendingPrompt?.text){await chrome.storage.local.remove('nanoPendingPrompt');els.prompt.value=nanoPendingPrompt.text;autoResize();updateCounter();if(nanoPendingPrompt.autoSend)await sendPrompt(nanoPendingPrompt.text)}}

els.composer.addEventListener('submit',e=>{e.preventDefault();sendPrompt(els.prompt.value)});
els.prompt.addEventListener('input',()=>{autoResize();updateCounter()});els.prompt.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();els.composer.requestSubmit()}});
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette();return}
  if(e.key==='Escape'){els.attachMenu?.classList.add('hidden');els.moreMenu?.classList.add('hidden');els.toolsMenu?.classList.add('hidden')}
  if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();els.prompt.focus()}
});
els.stopBtn.onclick=()=>abortController?.abort();els.newChat.onclick=createNewChat;els.chatSearch.oninput=renderChatList;els.folderFilter.onchange=renderChatList;els.sidebarToggle.onclick=()=>els.sidebar.classList.toggle('collapsed');
els.attachPage.onclick=()=>attachPage(false);els.selectionBtn.onclick=()=>attachPage(true);els.clearContext.onclick=()=>{pageContext=null;renderContext()};els.livePage.onchange=()=>{if(pageContext)pageContext.live=els.livePage.checked};els.fileBtn.onclick=()=>els.fileInput.click();els.fileInput.onchange=async()=>{await readFiles([...els.fileInput.files]);els.fileInput.value=''};els.screenBtn.onclick=captureScreen;els.exportBtn.onclick=exportChat;els.prepareAiBtn.onclick=prepareLocalAI;els.paletteBtn.onclick=openPalette;els.paletteSearch.oninput=renderPalette;
els.chatTitle.addEventListener('change',async()=>{const c=activeChat();if(!c)return;c.title=els.chatTitle.value.trim()||'שיחה חדשה';c.updatedAt=now();renderChatList();await persist()});
els.pageToolsBtn.addEventListener('click',e=>{e.stopPropagation();els.toolsMenu.classList.toggle('hidden')});document.addEventListener('click',()=>els.toolsMenu.classList.add('hidden'));els.toolsMenu.addEventListener('click',e=>e.stopPropagation());document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>runPageTool(b.dataset.tool));
els.settingsBtn.onclick=()=>els.settingsDialog.showModal();els.temperature.oninput=()=>els.temperatureValue.textContent=els.temperature.value;els.topK.oninput=()=>els.topKValue.textContent=els.topK.value;
els.saveSettings.addEventListener('click',async e=>{e.preventDefault();settings={profile:els.profile.value,responseStyle:els.responseStyle.value,answerLanguage:els.answerLanguage.value,temperature:Number(els.temperature.value),topK:Number(els.topK.value),systemPrompt:els.systemPrompt.value.trim()||DEFAULT_SETTINGS.systemPrompt,autoTitle:els.autoTitle.checked,smartContext:els.smartContext.checked,qualityTuned:true};resetSession();await persist();els.settingsDialog.close();setStatus('הגדרות נשמרו','ok');toast('ההגדרות נשמרו','success')});
els.attachMenuBtn.onclick=e=>{e.stopPropagation();els.moreMenu.classList.add('hidden');els.attachMenu.classList.toggle('hidden')};
els.moreBtn.onclick=e=>{e.stopPropagation();els.attachMenu.classList.add('hidden');els.moreMenu.classList.toggle('hidden')};
document.addEventListener('click',()=>{els.attachMenu?.classList.add('hidden');els.moreMenu?.classList.add('hidden')});
els.attachMenu?.addEventListener('click',e=>e.stopPropagation());els.moreMenu?.addEventListener('click',e=>e.stopPropagation());
els.debugLanguageBtn.onclick=()=>{renderLanguageDebug();els.languageDebugDialog.showModal();els.moreMenu.classList.add('hidden')};
els.closeLanguageDebug.onclick=()=>els.languageDebugDialog.close();
els.copyLanguageDebug.onclick=async()=>{await navigator.clipboard.writeText(languageDebugText());toast('האבחון הועתק','success')};
els.moreExportBtn.onclick=()=>{els.moreMenu.classList.add('hidden');exportChat()};
els.moreSettingsBtn.onclick=()=>{els.moreMenu.classList.add('hidden');els.settingsDialog.showModal()};
els.diagnosticsBtn.onclick=openDiagnostics;els.closeDiagnostics.onclick=()=>els.diagnosticsDialog.close();els.refreshDiagnostics.onclick=renderDiagnostics;els.runSelfTest.onclick=runSelfTest;
chrome.storage.onChanged.addListener(async(changes,area)=>{if(area!=='local')return;if(changes.nanoPendingPrompt?.newValue?.text){const p=changes.nanoPendingPrompt.newValue;await chrome.storage.local.remove('nanoPendingPrompt');els.prompt.value=p.text;autoResize();updateCounter();if(p.autoSend)await sendPrompt(p.text)}if(changes.nanoCommand?.newValue?.type==='new-chat'){await chrome.storage.local.remove('nanoCommand');await createNewChat()}});

(async()=>{await loadState();await checkAvailability();await consumePending();els.prompt.focus()})();