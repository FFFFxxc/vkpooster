"use strict";

const $ = (id) => document.getElementById(id);
const state = { tab:"waiting", waiting:[], posts:[], comments:[], stories:[], clips:[], history:[], groupLabels:{}, pause:null };
let selectedWaitingId = null;
let toastTimer = null;
let groupDirectoryLoaded = false;

function runtimeMessage(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(new Error(response?.error || "Неизвестная ошибка")); else resolve(response);
  }));
}

function toast(text, type = "info") { clearTimeout(toastTimer); const box=$("toast"); box.textContent=text; box.className=`toast ${type}`; box.hidden=false; toastTimer=setTimeout(()=>{box.hidden=true;},4500); }
function formatDate(value) { if (!value) return "—"; const date=new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"short"}) : "—"; }
function statusLabel(status) { return ({queued:"В очереди",processing:"Публикуется",paused:"Пауза",done:"Готово",completed:"Готово",partial:"Частично",failed:"Ошибка",cancelled:"Отменено",uploading:"Файл загружается",opening_tab:"Открываю VK",transferring:"Передаю файл"})[status]||status; }
function groupName(groupId) { const id=Math.abs(Number(groupId)); return state.groupLabels[String(id)]||`club${id}`; }
function largestPhotoUrl(photo) {
  const sizes=Array.isArray(photo?.sizes)?photo.sizes.filter((size)=>size?.url):[];
  if(sizes.length){
    const best=sizes.reduce((current,size)=>{
      const currentArea=(Number(current.width)||0)*(Number(current.height)||0);
      const sizeArea=(Number(size.width)||0)*(Number(size.height)||0);
      return sizeArea>=currentArea?size:current;
    });
    return best?.url||"";
  }
  return photo?.orig_photo?.url||photo?.url||"";
}
function uniqueImageUrls(values) {
  const seen=new Set();
  return (Array.isArray(values)?values:[]).flatMap((value)=>{
    const url=String(value||"").trim();
    if(!url||seen.has(url))return [];
    seen.add(url);return [url];
  });
}
function postPhotos(post,cachedImages=[]) {
  const posts=[post,...(Array.isArray(post?.copy_history)?post.copy_history:[])].filter(Boolean);
  const remote=posts.flatMap((source)=>(source.attachments||[]).flatMap((item)=>{
    if(item?.type!=="photo"||!item.photo)return [];
    const url=largestPhotoUrl(item.photo);return url?[url]:[];
  }));
  const cached=uniqueImageUrls(cachedImages);
  if(cached.length&&cached.length===remote.length)return cached;
  return uniqueImageUrls(remote.length?remote:cached);
}
function active(items) { return items.filter((item)=>!["completed","done","failed","cancelled"].includes(item.status)); }
function make(tag,className,text) { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; }
function addButton(root,text,handler,kind="") { const button=make("button",kind,text); button.type="button"; button.onclick=()=>void Promise.resolve(handler()).catch((error)=>toast(error.message,"error")); root.appendChild(button); return button; }

function mediaBlock(card,rawImages,portrait=false) {
  const images=uniqueImageUrls(rawImages);
  if(!images.length)return;
  const media=make("div",`card-media card-gallery${portrait?" portrait":""}${images.length>1?" multiple":""}`);
  media.setAttribute("role","region");
  media.setAttribute("aria-label",images.length>1?`Галерея: ${images.length} фото`:"Превью публикации");
  media.tabIndex=images.length>1?0:-1;
  const stage=make("div","gallery-stage");
  const slides=images.map((url,index)=>{
    const slide=make("div","gallery-slide");
    const image=make("img");
    image.src=url;image.alt=`Фото ${index+1} из ${images.length}`;image.referrerPolicy="no-referrer";image.draggable=false;image.loading=index===0?"eager":"lazy";
    slide.appendChild(image);stage.appendChild(slide);return slide;
  });
  media.appendChild(stage);
  let current=0;
  const dots=[];
  const counter=images.length>1?make("span","gallery-counter"):null;
  const update=(next,direction=0)=>{
    current=(next+images.length)%images.length;
    media.dataset.direction=direction<0?"previous":"next";
    slides.forEach((slide,index)=>{
      slide.classList.toggle("is-active",index===current);
      slide.classList.toggle("is-before",index<current);
      slide.classList.toggle("is-after",index>current);
      slide.setAttribute("aria-hidden",index===current?"false":"true");
    });
    dots.forEach((dot,index)=>{dot.classList.toggle("active",index===current);dot.setAttribute("aria-current",index===current?"true":"false");});
    if(counter)counter.textContent=`${current+1} / ${images.length}`;
  };
  const move=(step)=>update(current+step,step);
  if(images.length>1){
    const previous=make("button","gallery-arrow previous","‹");previous.type="button";previous.title="Предыдущее фото";previous.setAttribute("aria-label","Предыдущее фото");previous.onclick=(event)=>{event.stopPropagation();move(-1);};
    const next=make("button","gallery-arrow next","›");next.type="button";next.title="Следующее фото";next.setAttribute("aria-label","Следующее фото");next.onclick=(event)=>{event.stopPropagation();move(1);};
    const dotRow=make("div","gallery-dots");
    images.forEach((_,index)=>{const dot=make("button","gallery-dot");dot.type="button";dot.setAttribute("aria-label",`Показать фото ${index+1}`);dot.onclick=(event)=>{event.stopPropagation();update(index,index<current?-1:1);};dots.push(dot);dotRow.appendChild(dot);});
    media.append(previous,next,counter,dotRow);
    media.addEventListener("keydown",(event)=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();move(event.key==="ArrowLeft"?-1:1);}});
    let dragStart=null;
    media.addEventListener("pointerdown",(event)=>{if(event.button===0&&!event.target.closest("button"))dragStart=event.clientX;});
    media.addEventListener("pointerup",(event)=>{if(dragStart===null)return;const distance=event.clientX-dragStart;dragStart=null;if(Math.abs(distance)>=36)move(distance>0?-1:1);});
    media.addEventListener("pointercancel",()=>{dragStart=null;});
  }
  const canTilt=matchMedia("(hover: hover) and (pointer: fine)").matches&&!matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(canTilt){
    media.addEventListener("pointermove",(event)=>{if(event.target.closest("button"))return;const bounds=media.getBoundingClientRect();const x=(event.clientX-bounds.left)/bounds.width-.5;const y=(event.clientY-bounds.top)/bounds.height-.5;media.style.setProperty("--gallery-tilt-x",`${(-y*7).toFixed(2)}deg`);media.style.setProperty("--gallery-tilt-y",`${(x*9).toFixed(2)}deg`);});
    media.addEventListener("pointerleave",()=>{media.style.removeProperty("--gallery-tilt-x");media.style.removeProperty("--gallery-tilt-y");});
  }
  update(0);card.appendChild(media);
}
function baseCard({title,status,text,meta,error,image,images,portrait=false}) {
  const card=make("article","card"); mediaBlock(card,images?.length?images:(image?[image]:[]),portrait); const body=make("div","card-body"); const head=make("div","card-head"); head.append(make("div","card-title",title),make("span",`status ${status}`,statusLabel(status))); body.appendChild(head);
  if(text)body.appendChild(make("div","card-text",text)); if(meta)body.appendChild(make("div","meta",meta)); if(error)body.appendChild(make("div","error",error)); card.appendChild(body); return {card,body};
}
function actions(body) { const root=make("div","actions"); body.appendChild(root); return root; }
function empty(text){$("cards").appendChild(make("div","empty",text));}

function describePause(pause) {
  const hasCode=pause?.code!==null&&pause?.code!==undefined&&pause?.code!=="";
  const code=hasCode&&Number.isFinite(Number(pause.code))?Number(pause.code):null;
  const rawMessage=String(pause?.message||"").trim();
  if(pause?.reason==="ambiguous_repost"){
    return {
      title:"Нужно проверить спорный репост",
      message:"Браузер остановился во время репоста, поэтому расширение не может безопасно определить, появился ли он на стене.",
      technical:rawMessage&&rawMessage!=="Результат репоста неизвестен после остановки браузера. Проверьте стену группы перед ручным продолжением."?`Сохранённая причина: ${rawMessage}`:"",
      help:"Откройте остановленный пост ниже и выберите: репост уже появился, его нужно повторить или задание нужно отменить.",
    };
  }
  const codeMessages={
    6:"VK временно ограничил частоту запросов (код 6).",
    9:"VK включил защиту от слишком частых однотипных действий (код 9).",
    14:"VK запросил CAPTCHA (код 14).",
    17:"VK запросил подтверждение действия или проверку аккаунта (код 17).",
    29:"VK ограничил количество вызовов этого метода (код 29).",
  };
  const translated=codeMessages[code]||"";
  const missing=!rawMessage;
  const sourceTitles={
    post:"Расширение поставило отправку поста на паузу",
    comment:"Расширение поставило отложенный комментарий на паузу",
    deletion:"Расширение поставило автоудаление на паузу",
    cleanup:"Расширение остановило очистку паблика",
  };
  return {
    title:sourceTitles[pause?.source]||(pause?.jobId?sourceTitles.post:"Защитная пауза локальной автоматизации"),
    message:translated||rawMessage||"Расширение сохранило старую паузу без текста причины. Такое возможно после обновления или перезапуска браузера.",
    technical:translated&&rawMessage&&rawMessage!==translated?`Ответ VK: ${rawMessage}`:(!translated&&code?`Код ответа VK: ${code}`:""),
    help:missing?"Откройте VK, убедитесь, что аккаунт работает и нет CAPTCHA или запроса подтверждения. После этого очередь можно продолжить.":"Расширение специально прекратило новые посты и локальные комментарии, чтобы не повторять запросы. Проверьте VK вручную и только затем продолжайте.",
  };
}

function updatePauseAlert() {
  const alert=$("pause-alert");
  const pause=state.pause;
  alert.hidden=!pause;
  if(!pause)return;
  const view=describePause(pause);
  $("pause-title").textContent=view.title;
  $("pause-message").textContent=view.message;
  $("pause-help").textContent=view.help;
  const technical=$("pause-technical");technical.textContent=view.technical;technical.hidden=!view.technical;
  const job=state.posts.find((item)=>item.id===pause.jobId);
  const jobBits=[];
  if(pause.pausedAt)jobBits.push(`Пауза с ${formatDate(pause.pausedAt)}`);
  if(job?.label)jobBits.push(job.label);
  if(job?.pausedGroupId)jobBits.push(groupName(job.pausedGroupId));
  const sourceLabels={post:"постинг",comment:"отложенный комментарий",deletion:"автоудаление",cleanup:"очистка паблика"};
  if(!job&&sourceLabels[pause.source])jobBits.push(`Операция: ${sourceLabels[pause.source]}`);
  $("pause-meta").textContent=jobBits.join(" · ");
  $("pause-open-job").hidden=!job;
  const needsDecision=pause.reason==="ambiguous_repost";
  $("resume").disabled=needsDecision;
  $("resume").textContent=needsDecision?"Сначала выберите результат репоста":"Я проверил VK — продолжить";
  $("resume").title=needsDecision?"Откройте остановленный пост и укажите, появился ли репост.":"";
}

function selectTab(tab) {
  state.tab=tab;
  document.querySelectorAll(".tabs button").forEach((button)=>button.classList.toggle("active",button.dataset.tab===tab));
  render();
}

function showPausedJob() {
  const jobId=state.pause?.jobId;
  if(!jobId)return;
  selectTab("posts");
  requestAnimationFrame(()=>{
    const card=[...document.querySelectorAll(".card[data-job-id]")].find((item)=>item.dataset.jobId===jobId);
    if(!card)return;
    card.classList.add("pause-focus");
    card.scrollIntoView({behavior:"smooth",block:"center"});
    setTimeout(()=>card.classList.remove("pause-focus"),2600);
  });
}

function appendPublishResults(body, results) {
  const items=Array.isArray(results)?results:[];
  if(!items.length)return;
  const ok=items.filter((item)=>item.ok).length;
  const fail=items.length-ok;
  const details=make("details","result-details");
  details.open=fail>0;
  details.appendChild(make("summary","result-summary",`По сообществам: ${ok} успешно · ${fail} ошибок`));
  const list=make("div","result-list");
  for(const result of items){
    const row=make("div",`result-item ${result.ok?"success":"failure"}`);
    const head=make("div","result-head");
    const title=make("strong","",groupName(result.gid));
    title.title=`club${Math.abs(Number(result.gid))}`;
    head.append(title,make("span","result-badge",result.ok?"Опубликовано":"Ошибка"));
    row.appendChild(head);
    if(result.postId){
      const link=make("a","result-link",`Открыть пост #${result.postId}`);
      link.href=`https://vk.ru/wall-${Math.abs(Number(result.gid))}_${result.postId}`;
      link.target="_blank";link.rel="noreferrer";row.appendChild(link);
    }
    if(result.error)row.appendChild(make("div","result-error",result.error));
    if(result.warning)row.appendChild(make("div","result-warning",result.warning));
    list.appendChild(row);
  }
  details.appendChild(list);body.appendChild(details);
}

async function loadAll() {
  const local = await chrome.storage.local.get(["vkr_waiting_posts","vkr_posts_history","vkr_scheduled_comments","vkr_group_tokens"]);
  state.waiting=Array.isArray(local.vkr_waiting_posts)?local.vkr_waiting_posts:[];
  state.history=Array.isArray(local.vkr_posts_history)?local.vkr_posts_history:[];
  state.groupLabels=Object.fromEntries(Object.entries(local.vkr_group_tokens||{}).map(([groupId,raw])=>{
    const entry=raw&&typeof raw==="object"?raw:{};
    const id=String(Math.abs(Number(groupId)));
    return [id,String(entry.label||"").trim()||`club${id}`];
  }));
  if(!groupDirectoryLoaded){
    try{
      const directory=await runtimeMessage({type:"list_clip_groups"});
      for(const group of directory.groups||[]){
        const id=String(Math.abs(Number(group.id)));
        if(id!=="NaN"&&group.name)state.groupLabels[id]=String(group.name);
      }
    }catch{/* сохранённые подписи остаются рабочим fallback */}
    groupDirectoryLoaded=true;
  }
  const queue=await runtimeMessage({type:"get_queue_status"}); state.posts=queue.queue||[]; state.pause=queue.pause||null;
  const localComments=(local.vkr_scheduled_comments||[]).map((item)=>({...item,id:item.idempotencyKey||`local_${item.groupId}_${item.postId}`,status:"queued",commentAt:item.commentAt,local:true}));
  try { const server=await runtimeMessage({type:"list_scheduled_comments"}); state.comments=[...(server.jobs||[]),...localComments]; } catch { state.comments=localComments; }
  try { const stories=await VkrServerClient.request("/scheduled-stories?limit=200"); state.stories=stories.jobs||[]; } catch { state.stories=[]; }
  try { const clips=await runtimeMessage({type:"clips_list"}); state.clips=[...(clips.queue||[]),...(clips.history||[])].filter((job,index,all)=>all.findIndex((item)=>item.id===job.id)===index); } catch { state.clips=[]; }
  updateCounts(); render();
}

function updateCounts() {
  const counts={waiting:state.waiting.length,posts:active(state.posts).length,comments:active(state.comments).length,stories:active(state.stories).length,clips:active(state.clips).length,history:state.history.length};
  for(const [key,value] of Object.entries(counts)){const badge=$(`badge-${key}`);if(badge)badge.textContent=String(value);}
  $("sum-waiting").textContent=counts.waiting;$("sum-posts").textContent=counts.posts;$("sum-comments").textContent=counts.comments;$("sum-stories").textContent=counts.stories;$("sum-clips").textContent=counts.clips;
  updatePauseAlert();
}

function renderWaiting() {
  if(!state.waiting.length)return empty("Пока пусто. Во ВКонтакте нажмите «⏳ В ожидания» у нужного поста.");
  for(const item of [...state.waiting].reverse()){
    const {card,body}=baseCard({title:`wall${item.post?.owner_id}_${item.post?.id}`,status:"queued",text:item.post?.text||"Пост без текста",meta:`Добавлен ${formatDate(item.addedAt)}`,images:postPhotos(item.post,item.photoDataUrls)});
    const root=actions(body);addButton(root,"Опубликовать",()=>openPublish(item),"primary");addButton(root,"Источник",()=>chrome.tabs.create({url:item.url}));addButton(root,"Убрать",async()=>{state.waiting=state.waiting.filter((candidate)=>candidate.id!==item.id);await chrome.storage.local.set({vkr_waiting_posts:state.waiting});updateCounts();render();},"danger");$("cards").appendChild(card);
  }
}

function renderPosts() {
  if(!state.posts.length)return empty("Локальная очередь постинга пуста.");
  for(const job of [...state.posts].reverse()){
    const progress=job.progress||{};const displayStatus=(progress.ok||0)>0&&(progress.fail||0)>0?"partial":job.status;const {card,body}=baseCard({title:job.label||`Пост #${job.post?.id||"?"}`,status:displayStatus,text:job.post?.text||job.text||"",meta:`${formatDate(job.pubDate||job.createdAt)} · групп ${job.groups?.length||0} · успешно ${progress.ok||0}, ошибок ${progress.fail||0}`,error:job.error,images:postPhotos(job.post,job.previewImages)});
    card.dataset.jobId=job.id;
    if(state.pause?.jobId===job.id)card.classList.add("paused-target");
    appendPublishResults(body,job.results);
    if(["queued","processing"].includes(job.status)){const bar=make("div","progress");const fill=make("span");fill.style.width=`${Math.round(((progress.ok||0)+(progress.fail||0))/Math.max(1,progress.total||job.groups?.length||1)*100)}%`;bar.appendChild(fill);body.appendChild(bar);}
    if(job.status==="paused"&&job.pauseReason==="ambiguous_repost"){
      const root=actions(body);addButton(root,"Уже есть — пропустить",async()=>{await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"skip"});await loadAll();},"primary");addButton(root,"Нет — повторить",async()=>{if(confirm("Вы проверили стену и репоста точно нет?")){await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"retry"});await loadAll();}});addButton(root,"Отменить",async()=>{await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"cancel"});await loadAll();},"danger");
    }
    $("cards").appendChild(card);
  }
}

function renderComments() {
  if(!state.comments.length)return empty("Нет отложенных комментариев.");
  for(const job of state.comments){const groupId=Math.abs(Number(job.groupId));const {card,body}=baseCard({title:`${groupName(groupId)} · пост ${job.postId}`,status:job.status,text:job.commentText,meta:`club${groupId} · выполнить ${formatDate(job.commentAt)}`,error:job.lastError});if(!job.local&&["queued","paused","failed"].includes(job.status)){const root=actions(body);addButton(root,"Удалить",async()=>{if(confirm("Удалить отложенный комментарий?")){await runtimeMessage({type:"delete_scheduled_comment",id:job.id});await loadAll();}},"danger");}$("cards").appendChild(card);}
}

function renderStories() {
  if(!state.stories.length)return empty("Нет историй. Нажмите «＋ История», чтобы запланировать первую.");
  for(const job of state.stories){const {card,body}=baseCard({title:job.groupName||`club${job.groupId}`,status:job.status,text:job.linkUrl?`Кнопка: ${job.linkUrl}`:"История без ссылки",meta:`${formatDate(job.publishAt)} · ${job.fileName||"файл не загружен"}`,error:job.lastError,image:job.previewDataUrl,portrait:true});if(["uploading","queued","paused","failed"].includes(job.status)){const root=actions(body);if(["paused","failed"].includes(job.status))addButton(root,"Повторить",async()=>{await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(job.id)}/retry`,{method:"POST"});await loadAll();},"primary");addButton(root,"Отменить",async()=>{if(confirm("Отменить историю и удалить файл?")){await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(job.id)}`,{method:"DELETE"});await loadAll();}},"danger");}$("cards").appendChild(card);}
}

function renderClips() {
  if(!state.clips.length)return empty("Нет клипов. Нажмите «＋ Клипы», чтобы открыть загрузчик.");
  for(const job of state.clips){const {card,body}=baseCard({title:job.fileName||"Клип",status:job.status,text:job.description||"Без описания",meta:`${job.groupName||`club${job.groupId}`} · ${formatDate(job.publishAt||job.createdAt)}`,error:job.error});if(["opening_tab","transferring","uploading"].includes(job.status)){const bar=make("div","progress");const fill=make("span");fill.style.width=`${job.progress||0}%`;bar.appendChild(fill);body.appendChild(bar);}if(["queued","opening_tab","transferring","uploading","paused"].includes(job.status)){const root=actions(body);if(job.status==="paused")addButton(root,"Продолжить",async()=>{await runtimeMessage({type:"clips_resume",jobId:job.id});await loadAll();},"primary");addButton(root,"Отменить",async()=>{if(confirm("Отменить клип?")){await runtimeMessage({type:"clips_cancel",jobId:job.id});await loadAll();}},"danger");}$("cards").appendChild(card);}
}

function renderHistory(){if(!state.history.length)return empty("История публикаций пока пуста.");for(const item of state.history){const displayStatus=(item.ok||0)>0&&(item.fail||0)>0?"partial":item.status||"completed";const {card,body}=baseCard({title:item.label||"Публикация",status:displayStatus,text:item.mode==="repost"?"Оригинальный репост":"Копия поста",meta:`${formatDate(item.timestamp)} · успешно ${item.ok||0}, ошибок ${item.fail||0}`,error:item.error});appendPublishResults(body,item.results);$("cards").appendChild(card);}}

const tabInfo={waiting:["Ожидания","Посты, которые вы отметили во ВКонтакте"],posts:["Очередь постов","Последовательная локальная публикация"],comments:["Комментарии 24/7","Серверные и локальные отложенные комментарии"],stories:["Истории","Отложенные истории сообществ с превью"],clips:["Клипы","Одна видимая вкладка VK на публикацию"],history:["История","Последние результаты постинга"]};
function render(){const cards=$("cards");cards.replaceChildren();const [title,hint]=tabInfo[state.tab];$("section-title").textContent=title;$("section-hint").textContent=hint;$("clear-finished").hidden=state.tab!=="posts";({waiting:renderWaiting,posts:renderPosts,comments:renderComments,stories:renderStories,clips:renderClips,history:renderHistory})[state.tab]();}

async function openPublish(item){selectedWaitingId=item.id;$("publish-text").value=item.post?.text||"";$("publish-comment").value="";$("publish-date").value="";$("publish-mode").value="copy";$("dialog-preview").textContent=item.post?.text||"Пост без текста";const data=await chrome.storage.local.get("vkr_group_tokens");const root=$("publish-groups");root.replaceChildren();for(const [groupId,raw] of Object.entries(data.vkr_group_tokens||{})){const entry=typeof raw==="object"?raw:{};const label=make("label");const input=make("input");input.type="checkbox";input.name="publish-group";input.value=groupId;label.append(input,document.createTextNode(` ${entry.label||`club${groupId}`}`));root.appendChild(label);}if(!root.children.length)root.appendChild(make("div","meta","Добавьте токены сообществ в настройках."));$("publish-dialog").showModal();}

async function submitPublish(event){event.preventDefault();const groups=[...document.querySelectorAll('input[name="publish-group"]:checked')].map((input)=>Number(input.value));if(!groups.length)return toast("Выберите хотя бы одно сообщество.","error");const data=await chrome.storage.local.get(["vkr_waiting_posts","vk_token"]);const item=(data.vkr_waiting_posts||[]).find((candidate)=>candidate.id===selectedWaitingId);if(!item)return toast("Пост больше не найден.","error");const mode=$("publish-mode").value;if(mode==="repost"&&!data.vk_token)return toast("Для репоста нужен локальный пользовательский токен.","error");const pubDate=$("publish-date").value?new Date($("publish-date").value).getTime():null;if(pubDate&&pubDate<=Date.now())return toast("Дата должна быть в будущем.","error");const button=$("publish-submit");button.disabled=true;try{await runtimeMessage({type:"enqueue_publish",post:item.post,groups,mode,text:mode==="copy"?$("publish-text").value:"",pubDate,processedPhotos:[],autoCommentText:$("publish-comment").value.trim(),label:`Пост из ожиданий #${item.post?.id||"?"}`});state.waiting=(data.vkr_waiting_posts||[]).filter((candidate)=>candidate.id!==item.id);await chrome.storage.local.set({vkr_waiting_posts:state.waiting});$("publish-dialog").close();toast("Пост добавлен в последовательную очередь.");await loadAll();}finally{button.disabled=false;}}

async function resumePublishQueue() {
  const result=await runtimeMessage({type:"resume_publish_queue"});
  if(result.requiresDecision){toast(result.message||"Сначала решите, что делать со спорным репостом.","error");showPausedJob();return;}
  toast("Локальная очередь продолжена.");await loadAll();
}

async function init(){document.querySelectorAll(".tabs button").forEach((button)=>button.onclick=()=>selectTab(button.dataset.tab));$("refresh").onclick=loadAll;$("settings").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("popup.html")});$("new-story").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("stories.html")});$("new-clips").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("clips.html")});$("close-dialog").onclick=()=>$("publish-dialog").close();$("publish-form").onsubmit=submitPublish;$("pause-open-vk").onclick=()=>chrome.tabs.create({url:"https://vk.ru/"});$("pause-open-job").onclick=showPausedJob;$("resume").onclick=resumePublishQueue;$("clear-finished").onclick=async()=>{await runtimeMessage({type:"clear_finished_queue"});await loadAll();};await loadAll();setInterval(loadAll,15_000);}
document.addEventListener("DOMContentLoaded",()=>void init().catch((error)=>toast(error.message,"error")));
