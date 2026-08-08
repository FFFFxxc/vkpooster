"use strict";

const $ = (id) => document.getElementById(id);
const state = { tab:"waiting", waiting:[], posts:[], comments:[], stories:[], clips:[], history:[], pause:null };
let selectedWaitingId = null;
let toastTimer = null;

function runtimeMessage(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(new Error(response?.error || "Неизвестная ошибка")); else resolve(response);
  }));
}

function toast(text, type = "info") { clearTimeout(toastTimer); const box=$("toast"); box.textContent=text; box.className=`toast ${type}`; box.hidden=false; toastTimer=setTimeout(()=>{box.hidden=true;},4500); }
function formatDate(value) { if (!value) return "—"; const date=new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"short"}) : "—"; }
function statusLabel(status) { return ({queued:"В очереди",processing:"Публикуется",paused:"Пауза",done:"Готово",completed:"Готово",failed:"Ошибка",cancelled:"Отменено",uploading:"Файл загружается",opening_tab:"Открываю VK",transferring:"Передаю файл"})[status]||status; }
function firstPhoto(post) { const photo=(post?.attachments||[]).find((item)=>item.type==="photo"&&item.photo)?.photo; return [...(photo?.sizes||[])].sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0))[0]?.url||""; }
function active(items) { return items.filter((item)=>!["completed","done","failed","cancelled"].includes(item.status)); }
function make(tag,className,text) { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; }
function addButton(root,text,handler,kind="") { const button=make("button",kind,text); button.onclick=()=>void Promise.resolve(handler()).catch((error)=>toast(error.message,"error")); root.appendChild(button); return button; }

function mediaBlock(card,url,portrait=false) { if(!url)return; const media=make("div","card-media"); if(portrait)media.style.height="250px"; const image=make("img"); image.src=url; image.alt=""; image.referrerPolicy="no-referrer"; media.appendChild(image); card.appendChild(media); }
function baseCard({title,status,text,meta,error,image,portrait=false}) {
  const card=make("article","card"); mediaBlock(card,image,portrait); const body=make("div","card-body"); const head=make("div","card-head"); head.append(make("div","card-title",title),make("span",`status ${status}`,statusLabel(status))); body.appendChild(head);
  if(text)body.appendChild(make("div","card-text",text)); if(meta)body.appendChild(make("div","meta",meta)); if(error)body.appendChild(make("div","error",error)); card.appendChild(body); return {card,body};
}
function actions(body) { const root=make("div","actions"); body.appendChild(root); return root; }
function empty(text){$("cards").appendChild(make("div","empty",text));}

async function loadAll() {
  const local = await chrome.storage.local.get(["vkr_waiting_posts","vkr_posts_history","vkr_scheduled_comments"]);
  state.waiting=Array.isArray(local.vkr_waiting_posts)?local.vkr_waiting_posts:[];
  state.history=Array.isArray(local.vkr_posts_history)?local.vkr_posts_history:[];
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
  $("pause-alert").hidden=!state.pause;$("pause-message").textContent=state.pause?.message||"";
}

function renderWaiting() {
  if(!state.waiting.length)return empty("Пока пусто. Во ВКонтакте нажмите «⏳ В ожидания» у нужного поста.");
  for(const item of [...state.waiting].reverse()){
    const {card,body}=baseCard({title:`wall${item.post?.owner_id}_${item.post?.id}`,status:"queued",text:item.post?.text||"Пост без текста",meta:`Добавлен ${formatDate(item.addedAt)}`,image:firstPhoto(item.post)});
    const root=actions(body);addButton(root,"Опубликовать",()=>openPublish(item),"primary");addButton(root,"Источник",()=>chrome.tabs.create({url:item.url}));addButton(root,"Убрать",async()=>{state.waiting=state.waiting.filter((candidate)=>candidate.id!==item.id);await chrome.storage.local.set({vkr_waiting_posts:state.waiting});updateCounts();render();},"danger");$("cards").appendChild(card);
  }
}

function renderPosts() {
  if(!state.posts.length)return empty("Локальная очередь постинга пуста.");
  for(const job of [...state.posts].reverse()){
    const progress=job.progress||{};const {card,body}=baseCard({title:job.label||`Пост #${job.post?.id||"?"}`,status:job.status,text:job.post?.text||job.text||"",meta:`${formatDate(job.pubDate||job.createdAt)} · групп ${job.groups?.length||0} · успешно ${progress.ok||0}, ошибок ${progress.fail||0}`,error:job.error,image:firstPhoto(job.post)});
    if(["queued","processing"].includes(job.status)){const bar=make("div","progress");const fill=make("span");fill.style.width=`${Math.round(((progress.ok||0)+(progress.fail||0))/Math.max(1,progress.total||job.groups?.length||1)*100)}%`;bar.appendChild(fill);body.appendChild(bar);}
    if(job.status==="paused"&&job.pauseReason==="ambiguous_repost"){
      const root=actions(body);addButton(root,"Уже есть — пропустить",async()=>{await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"skip"});await loadAll();},"primary");addButton(root,"Нет — повторить",async()=>{if(confirm("Вы проверили стену и репоста точно нет?")){await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"retry"});await loadAll();}});addButton(root,"Отменить",async()=>{await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"cancel"});await loadAll();},"danger");
    }
    $("cards").appendChild(card);
  }
}

function renderComments() {
  if(!state.comments.length)return empty("Нет отложенных комментариев.");
  for(const job of state.comments){const {card,body}=baseCard({title:`club${job.groupId} · post ${job.postId}`,status:job.status,text:job.commentText,meta:`Выполнить ${formatDate(job.commentAt)}`,error:job.lastError});if(!job.local&&["queued","paused","failed"].includes(job.status)){const root=actions(body);addButton(root,"Удалить",async()=>{if(confirm("Удалить отложенный комментарий?")){await runtimeMessage({type:"delete_scheduled_comment",id:job.id});await loadAll();}},"danger");}$("cards").appendChild(card);}
}

function renderStories() {
  if(!state.stories.length)return empty("Нет историй. Нажмите «＋ История», чтобы запланировать первую.");
  for(const job of state.stories){const {card,body}=baseCard({title:job.groupName||`club${job.groupId}`,status:job.status,text:job.linkUrl?`Кнопка: ${job.linkUrl}`:"История без ссылки",meta:`${formatDate(job.publishAt)} · ${job.fileName||"файл не загружен"}`,error:job.lastError,image:job.previewDataUrl,portrait:true});if(["uploading","queued","paused","failed"].includes(job.status)){const root=actions(body);if(["paused","failed"].includes(job.status))addButton(root,"Повторить",async()=>{await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(job.id)}/retry`,{method:"POST"});await loadAll();},"primary");addButton(root,"Отменить",async()=>{if(confirm("Отменить историю и удалить файл?")){await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(job.id)}`,{method:"DELETE"});await loadAll();}},"danger");}$("cards").appendChild(card);}
}

function renderClips() {
  if(!state.clips.length)return empty("Нет клипов. Нажмите «＋ Клипы», чтобы открыть загрузчик.");
  for(const job of state.clips){const {card,body}=baseCard({title:job.fileName||"Клип",status:job.status,text:job.description||"Без описания",meta:`${job.groupName||`club${job.groupId}`} · ${formatDate(job.publishAt||job.createdAt)}`,error:job.error});if(["opening_tab","transferring","uploading"].includes(job.status)){const bar=make("div","progress");const fill=make("span");fill.style.width=`${job.progress||0}%`;bar.appendChild(fill);body.appendChild(bar);}if(["queued","opening_tab","transferring","uploading","paused"].includes(job.status)){const root=actions(body);if(job.status==="paused")addButton(root,"Продолжить",async()=>{await runtimeMessage({type:"clips_resume",jobId:job.id});await loadAll();},"primary");addButton(root,"Отменить",async()=>{if(confirm("Отменить клип?")){await runtimeMessage({type:"clips_cancel",jobId:job.id});await loadAll();}},"danger");}$("cards").appendChild(card);}
}

function renderHistory(){if(!state.history.length)return empty("История публикаций пока пуста.");for(const item of state.history){const {card}=baseCard({title:item.label||"Публикация",status:item.status||"completed",text:item.mode==="repost"?"Оригинальный репост":"Копия поста",meta:`${formatDate(item.timestamp)} · успешно ${item.ok||0}, ошибок ${item.fail||0}`,error:item.error});$("cards").appendChild(card);}}

const tabInfo={waiting:["Ожидания","Посты, которые вы отметили во ВКонтакте"],posts:["Очередь постов","Последовательная локальная публикация"],comments:["Комментарии 24/7","Серверные и локальные отложенные комментарии"],stories:["Истории","Отложенные истории сообществ с превью"],clips:["Клипы","Одна видимая вкладка VK на публикацию"],history:["История","Последние результаты постинга"]};
function render(){const cards=$("cards");cards.replaceChildren();const [title,hint]=tabInfo[state.tab];$("section-title").textContent=title;$("section-hint").textContent=hint;$("clear-finished").hidden=state.tab!=="posts";({waiting:renderWaiting,posts:renderPosts,comments:renderComments,stories:renderStories,clips:renderClips,history:renderHistory})[state.tab]();}

async function openPublish(item){selectedWaitingId=item.id;$("publish-text").value=item.post?.text||"";$("publish-comment").value="";$("publish-date").value="";$("publish-mode").value="copy";$("dialog-preview").textContent=item.post?.text||"Пост без текста";const data=await chrome.storage.local.get("vkr_group_tokens");const root=$("publish-groups");root.replaceChildren();for(const [groupId,raw] of Object.entries(data.vkr_group_tokens||{})){const entry=typeof raw==="object"?raw:{};const label=make("label");const input=make("input");input.type="checkbox";input.name="publish-group";input.value=groupId;label.append(input,document.createTextNode(` ${entry.label||`club${groupId}`}`));root.appendChild(label);}if(!root.children.length)root.appendChild(make("div","meta","Добавьте токены сообществ в настройках."));$("publish-dialog").showModal();}

async function submitPublish(event){event.preventDefault();const groups=[...document.querySelectorAll('input[name="publish-group"]:checked')].map((input)=>Number(input.value));if(!groups.length)return toast("Выберите хотя бы одно сообщество.","error");const data=await chrome.storage.local.get(["vkr_waiting_posts","vk_token"]);const item=(data.vkr_waiting_posts||[]).find((candidate)=>candidate.id===selectedWaitingId);if(!item)return toast("Пост больше не найден.","error");const mode=$("publish-mode").value;if(mode==="repost"&&!data.vk_token)return toast("Для репоста нужен локальный пользовательский токен.","error");const pubDate=$("publish-date").value?new Date($("publish-date").value).getTime():null;if(pubDate&&pubDate<=Date.now())return toast("Дата должна быть в будущем.","error");const button=$("publish-submit");button.disabled=true;try{await runtimeMessage({type:"enqueue_publish",post:item.post,groups,mode,text:mode==="copy"?$("publish-text").value:"",pubDate,processedPhotos:[],autoCommentText:$("publish-comment").value.trim(),label:`Пост из ожиданий #${item.post?.id||"?"}`});state.waiting=(data.vkr_waiting_posts||[]).filter((candidate)=>candidate.id!==item.id);await chrome.storage.local.set({vkr_waiting_posts:state.waiting});$("publish-dialog").close();toast("Пост добавлен в последовательную очередь.");await loadAll();}finally{button.disabled=false;}}

async function init(){document.querySelectorAll(".tabs button").forEach((button)=>button.onclick=()=>{state.tab=button.dataset.tab;document.querySelectorAll(".tabs button").forEach((item)=>item.classList.toggle("active",item===button));render();});$("refresh").onclick=loadAll;$("settings").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("popup.html")});$("new-story").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("stories.html")});$("new-clips").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("clips.html")});$("close-dialog").onclick=()=>$("publish-dialog").close();$("publish-form").onsubmit=submitPublish;$("resume").onclick=async()=>{await runtimeMessage({type:"resume_publish_queue"});await loadAll();};$("clear-finished").onclick=async()=>{await runtimeMessage({type:"clear_finished_queue"});await loadAll();};await loadAll();setInterval(loadAll,15_000);}
document.addEventListener("DOMContentLoaded",()=>void init().catch((error)=>toast(error.message,"error")));
