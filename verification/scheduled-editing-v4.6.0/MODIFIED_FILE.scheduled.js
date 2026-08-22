"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  tab:"waiting",
  waiting:[],
  posts:[],
  comments:[],
  stories:[],
  clips:[],
  history:[],
  groupLabels:{},
  groupPhotos:{},
  groupScreenNames:{},
  configuredGroupIds:[],
  pause:null,
  analytics:{days:7,loading:false,loaded:false,groups:[],postLimit:100,error:""},
};
let selectedWaitingId = null;
let selectedEdit = null;
let toastTimer = null;
let groupDirectoryLoaded = false;
let groupDirectorySignature = "";

function runtimeMessage(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(new Error(response?.error || "Неизвестная ошибка")); else resolve(response);
  }));
}

function toast(text, type = "info") { clearTimeout(toastTimer); const box=$("toast"); box.textContent=text; box.className=`toast ${type}`; box.hidden=false; toastTimer=setTimeout(()=>{box.hidden=true;},4500); }
function formatDate(value) { if (!value) return "—"; const date=new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"short"}) : "—"; }
function statusLabel(status) { return ({queued:"В очереди",processing:"Публикуется",scheduled:"Запланировано в VK",paused:"Пауза",done:"Готово",completed:"Готово",partial:"Частично",failed:"Ошибка",cancelled:"Отменено",uploading:"Файл загружается",opening_tab:"Открываю VK",transferring:"Передаю файл"})[status]||status; }
function groupName(groupId) { const id=Math.abs(Number(groupId)); return state.groupLabels[String(id)]||`club${id}`; }
function groupPhoto(groupId) { const id=String(Math.abs(Number(groupId))); return state.groupPhotos[id]||""; }
function groupUrl(groupId) { const id=String(Math.abs(Number(groupId))); return `https://vk.ru/${state.groupScreenNames[id]||`club${id}`}`; }
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
function terminal(item) { return ["completed","done","failed","cancelled"].includes(String(item?.status||"")); }
function hasRecordError(item) {
  if(String(item?.status||"")==="cancelled")return false;
  return String(item?.status||"")==="failed"||Number(item?.fail)>0||Number(item?.progress?.fail)>0||(Array.isArray(item?.results)&&item.results.some((result)=>result?.ok===false&&result?.cancelled!==true))||Boolean(String(item?.error||item?.lastError||"").trim());
}
function timestamp(value) { const direct=Number(value);if(Number.isFinite(direct)&&direct>0)return direct;const parsed=new Date(value).getTime();return Number.isFinite(parsed)?parsed:0; }
function postJobTime(job) { return timestamp(job.pubDate||job.publishAt||job.completedAt||job.createdAt); }
function sortPostJobs(items) {
  const finalStatuses=new Set(["completed","done","failed","cancelled"]);
  return [...items].sort((first,second)=>{
    const firstFinal=finalStatuses.has(first.status);const secondFinal=finalStatuses.has(second.status);
    if(firstFinal!==secondFinal)return firstFinal?1:-1;
    const difference=postJobTime(first)-postJobTime(second);
    if(difference!==0)return firstFinal?-difference:difference;
    return String(first.id||"").localeCompare(String(second.id||""));
  });
}
function compactDuration(milliseconds) {
  const seconds=Math.max(0,Math.ceil(Number(milliseconds||0)/1000));
  if(seconds<60)return `${seconds} сек`;
  const minutes=Math.ceil(seconds/60);
  if(minutes<60)return `${minutes} мин`;
  const hours=Math.floor(minutes/60);const rest=minutes%60;
  return rest?`${hours} ч ${rest} мин`:`${hours} ч`;
}
function publishProgressSnapshot(job) {
  const total=Math.max(1,Number(job.progress?.total)||job.groups?.length||1);
  const completed=Math.min(total,Number(job.progress?.current)||((Number(job.progress?.ok)||0)+(Number(job.progress?.fail)||0)));
  const media=job.mediaProgress||null;
  const mediaFraction=media?.total?Math.min(1,Math.max(0,(Number(media.current)||0)/Math.max(1,Number(media.total)||1))):0;
  const isProcessing=job.status==="processing";
  const activeFraction=isProcessing?(media?.total?0.12+mediaFraction*0.76:0.45):0;
  const percent=["completed","done","failed"].includes(job.status)?100:Math.min(99,Math.max(0,Math.round(((completed+activeFraction)/total)*100)));
  let stage="Ожидает своей очереди";
  let detail=`Обработано пабликов: ${completed} из ${total}`;
  if(job.cancelRequested){
    stage="Останавливаю публикацию";
    detail="Текущий запрос завершится, новые паблики обрабатываться не будут";
  }else if(job.status==="queued"&&job.source==="server"&&postJobTime(job)>Date.now()){
    stage="Сервер ожидает время публикации · ещё "+compactDuration(postJobTime(job)-Date.now());
    detail="Render загрузит фотографии в фактическое время "+formatDate(job.publishAt||job.pubDate)+" и сразу опубликует пост";
  }else if(job.status==="queued"&&job.deferMediaUntilPublish&&Number(job.pubDate)>Date.now()){
    stage=`Ожидание публикации · ещё ${compactDuration(Number(job.pubDate)-Date.now())}`;
    detail=`Загрузка начнётся ${formatDate(job.pubDate)}`;
  }else if(isProcessing&&media?.total){
    stage=`Загружаю фото в ${groupName(media.groupId)}`;
    detail=`Фото ${Number(media.current)||0} из ${Number(media.total)||0} · паблик ${Math.min(total,(Number(job.activeGroupIndex)||0)+1)} из ${total}`;
  }else if(isProcessing){
    stage=job.activeGroupId?`Публикую в ${groupName(job.activeGroupId)}`:"Подготавливаю публикацию";
  }else if(job.status==="paused"){
    stage="Публикация приостановлена";
  }
  return {percent,stage,detail};
}
function appendPostProgress(body,job) {
  if(!["queued","processing","paused"].includes(job.status))return;
  const snapshot=publishProgressSnapshot(job);
  const root=make("div","publish-progress");
  const header=make("div","publish-progress-head");
  header.append(make("strong","",snapshot.stage),make("b","",`${snapshot.percent}%`));
  const detail=make("span","publish-progress-detail",snapshot.detail);
  const bar=make("div","progress publish-progress-bar");
  bar.setAttribute("role","progressbar");bar.setAttribute("aria-valuemin","0");bar.setAttribute("aria-valuemax","100");bar.setAttribute("aria-valuenow",String(snapshot.percent));
  const fill=make("span");fill.style.width=`${snapshot.percent}%`;bar.appendChild(fill);
  root.append(header,detail,bar);body.appendChild(root);
}
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
  if(tab==="history")void loadAnalytics();
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
  const cancelled=items.filter((item)=>item.cancelled===true).length;
  const fail=items.length-ok-cancelled;
  const details=make("details","result-details");
  details.open=fail>0;
  details.appendChild(make("summary","result-summary",`По сообществам: ${ok} успешно · ${fail} ошибок${cancelled?` · ${cancelled} отменено`:""}`));
  const list=make("div","result-list");
  for(const result of items){
    const row=make("div",`result-item ${result.cancelled?"cancelled":result.ok?"success":"failure"}`);
    const head=make("div","result-head");
    const title=make("strong","",groupName(result.gid));
    title.title=`club${Math.abs(Number(result.gid))}`;
    head.append(title,make("span","result-badge",result.cancelled?"Отменено":result.ok?"Опубликовано":"Ошибка"));
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

function toDateTimeLocal(value) {
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return "";
  const shifted=new Date(date.getTime()-date.getTimezoneOffset()*60_000);
  return shifted.toISOString().slice(0,16);
}

function openPostEdit(job) {
  const originalTime=toDateTimeLocal(job.publishAt||job.pubDate);
  const canEditSchedule=(Number(job.nextGroupIndex)||0)===0&&!(job.results||[]).length;
  selectedEdit={kind:"post",job,originalTime,canEditSchedule};
  $("edit-kicker").textContent="Серверная публикация";
  $("edit-title").textContent="Редактировать пост и комментарий";
  $("edit-post-fields").hidden=false;$("edit-comment-fields").hidden=true;
  $("edit-post-mode").value=job.mode||"copy";
  $("edit-post-time").value=originalTime;$("edit-post-time").disabled=!canEditSchedule;
  $("edit-post-text").value=job.text||"";
  $("edit-auto-comment").value=job.autoCommentText||"";
  $("edit-note").textContent=canEditSchedule?"Можно изменить время, текст, режим и комментарий. Уже опубликованные цели не затрагиваются.":"Часть пабликов уже обработана: текст, режим и комментарий изменятся только для оставшихся; исходное время заблокировано.";
  $("edit-dialog").showModal();
}

function openCommentEdit(job) {
  const originalTime=toDateTimeLocal(job.commentAt);
  selectedEdit={kind:"comment",job,originalTime};
  $("edit-kicker").textContent="Отложенный комментарий";
  $("edit-title").textContent=`Редактировать комментарий для ${groupName(job.groupId)}`;
  $("edit-post-fields").hidden=true;$("edit-comment-fields").hidden=false;
  $("edit-comment-time").value=originalTime;
  $("edit-comment-text").value=job.commentText||"";
  $("edit-note").textContent="Можно изменить текст и время ещё не опубликованного комментария.";
  $("edit-dialog").showModal();
}

async function submitEdit(event) {
  event.preventDefault();if(!selectedEdit)return;
  const button=$("edit-submit");button.disabled=true;
  try{
    if(selectedEdit.kind==="post"){
      const local=$("edit-post-time").value;const timeChanged=selectedEdit.canEditSchedule&&local!==selectedEdit.originalTime;
      await runtimeMessage({type:"update_scheduled_post",id:selectedEdit.job.id,patch:{
        mode:$("edit-post-mode").value,text:$("edit-post-text").value,
        autoCommentText:$("edit-auto-comment").value,
        ...(timeChanged&&local?{publishAt:new Date(local).toISOString()}:{})
      }});
      toast("Пост и его отложенный комментарий обновлены.");
    }else{
      const local=$("edit-comment-time").value;const timeChanged=local!==selectedEdit.originalTime;
      await runtimeMessage({type:"update_scheduled_comment",id:selectedEdit.job.id,patch:{
        commentText:$("edit-comment-text").value,
        ...(timeChanged&&local?{commentAt:new Date(local).toISOString()}:{})
      }});
      toast("Отложенный комментарий обновлён.");
    }
    $("edit-dialog").close();selectedEdit=null;await loadAll();
  }finally{button.disabled=false;}
}

function appendPendingPostTargets(body,job) {
  if(job.source!=="server"||!["queued","paused","failed"].includes(job.status))return;
  const groups=Array.isArray(job.groups)?job.groups.map((id)=>Math.abs(Number(id))):[];
  const cancelled=new Set((job.cancelledGroupIds||[]).map((id)=>Math.abs(Number(id))));
  const processed=new Set((job.results||[]).map((item)=>Math.abs(Number(item.gid))));
  groups.slice(0,Number(job.nextGroupIndex)||0).forEach((id)=>processed.add(id));
  const pending=groups.filter((id)=>!processed.has(id)&&!cancelled.has(id));
  if(!pending.length)return;
  const details=make("details","pending-targets");
  details.appendChild(make("summary","",`Ещё не опубликовано: ${pending.length} · отменить отдельный паблик`));
  const list=make("div","pending-target-list");
  for(const groupId of pending){
    const row=make("div","pending-target");row.appendChild(make("span","",groupName(groupId)));
    addButton(row,"Не публиковать",async()=>{if(confirm(`Не публиковать этот пост в «${groupName(groupId)}»?`)){await runtimeMessage({type:"cancel_scheduled_post_group",id:job.id,groupId});toast(`Публикация в «${groupName(groupId)}» отменена.`);await loadAll();}},"danger");
    list.appendChild(row);
  }
  details.appendChild(list);body.appendChild(details);
}

function formatCompactNumber(value) {
  const number=Math.max(0,Number(value)||0);
  if(number>=1_000_000)return `${(number/1_000_000).toFixed(number>=10_000_000?0:1).replace(".0","")} млн`;
  if(number>=10_000)return `${(number/1_000).toFixed(number>=100_000?0:1).replace(".0","")} тыс.`;
  return number.toLocaleString("ru-RU");
}

function analyticsPeriodLabel(days) {
  if(days===7)return "за 7 дней";
  if(days===30)return "за 30 дней";
  return "по последним 100 записям каждой группы";
}

function analyticsMetrics(group,days) {
  const cutoff=days>0?Date.now()-days*24*60*60*1000:0;
  const posts=(Array.isArray(group.posts)?group.posts:[]).filter((post)=>Number(post.date)*1000>=cutoff);
  const metrics=posts.reduce((total,post)=>({
    posts:total.posts+1,
    likes:total.likes+(Number(post.likes)||0),
    views:total.views+(Number(post.views)||0),
    comments:total.comments+(Number(post.comments)||0),
    reposts:total.reposts+(Number(post.reposts)||0),
  }),{posts:0,likes:0,views:0,comments:0,reposts:0});
  metrics.interactions=metrics.likes+metrics.comments+metrics.reposts;
  metrics.perPost=metrics.posts?metrics.interactions/metrics.posts:0;
  metrics.engagementRate=metrics.views?metrics.interactions/metrics.views*100:0;
  return {...group,...metrics};
}

function analyticsStat(id,value) { const element=$(id);if(element)element.textContent=formatCompactNumber(value); }

function renderAnalytics() {
  const root=$("analytics-groups");
  if(!root)return;
  const analytics=state.analytics;
  document.querySelectorAll("[data-analytics-days]").forEach((button)=>button.classList.toggle("active",Number(button.dataset.analyticsDays)===analytics.days));
  $("analytics-hint").textContent=`Данные ${analyticsPeriodLabel(analytics.days)} · максимум ${analytics.postLimit||100} записей на группу`;
  root.replaceChildren();
  if(analytics.loading){["analytics-posts","analytics-likes","analytics-views","analytics-comments","analytics-reposts"].forEach((id)=>$(id).textContent="…");root.appendChild(make("div","analytics-empty analytics-loading","Загружаю статистику из VK… Группы опрашиваются последовательно."));return;}
  if(analytics.error){["analytics-posts","analytics-likes","analytics-views","analytics-comments","analytics-reposts"].forEach((id)=>$(id).textContent="—");root.appendChild(make("div","analytics-empty analytics-error",analytics.error));return;}
  if(!analytics.loaded){root.appendChild(make("div","analytics-empty","Откройте вкладку, чтобы загрузить статистику настроенных групп."));return;}

  const rows=analytics.groups.map((group)=>analyticsMetrics(group,analytics.days));
  const totals=rows.reduce((sum,row)=>({
    posts:sum.posts+row.posts,
    likes:sum.likes+row.likes,
    views:sum.views+row.views,
    comments:sum.comments+row.comments,
    reposts:sum.reposts+row.reposts,
  }),{posts:0,likes:0,views:0,comments:0,reposts:0});
  analyticsStat("analytics-posts",totals.posts);
  analyticsStat("analytics-likes",totals.likes);
  analyticsStat("analytics-views",totals.views);
  analyticsStat("analytics-comments",totals.comments);
  analyticsStat("analytics-reposts",totals.reposts);
  const freshest=Math.max(0,...rows.map((row)=>Number(row.fetchedAt)||0));
  $("analytics-updated").textContent=freshest?`Обновлено ${formatDate(freshest)}`:"";

  if(!rows.length){root.appendChild(make("div","analytics-empty","Нет доступных сообществ. Обновите список в настройках расширения."));return;}
  rows.sort((first,second)=>second.perPost-first.perPost||second.interactions-first.interactions||second.views-first.views||groupName(first.groupId).localeCompare(groupName(second.groupId),"ru"));
  const best=Math.max(1,...rows.map((row)=>row.perPost));
  rows.forEach((row,index)=>{
    const card=make("article",`analytics-group${row.error?" has-error":""}`);
    const rank=make("div",`analytics-rank rank-${Math.min(index+1,4)}`,index<3?["🥇","🥈","🥉"][index]:`#${index+1}`);
    const avatarWrap=make("div","analytics-avatar");
    const photo=groupPhoto(row.groupId);
    if(photo){const image=make("img");image.src=photo;image.alt="";image.referrerPolicy="no-referrer";image.onerror=()=>{image.remove();avatarWrap.textContent=groupName(row.groupId).slice(0,1).toUpperCase();};avatarWrap.appendChild(image);}else avatarWrap.textContent=groupName(row.groupId).slice(0,1).toUpperCase();
    const identity=make("div","analytics-identity");
    const link=make("a","",groupName(row.groupId));link.href=groupUrl(row.groupId);link.target="_blank";link.rel="noreferrer";
    identity.append(link,make("span","",`${row.posts} публикаций · ${row.interactions} реакций`));
    const activity=make("div","analytics-activity");
    activity.append(make("b","",row.perPost.toLocaleString("ru-RU",{maximumFractionDigits:1})),make("span","","реакций / пост"));
    const head=make("div","analytics-group-head");head.append(rank,avatarWrap,identity,activity);card.appendChild(head);
    const stats=make("div","analytics-group-stats");
    [["♥","Лайки",row.likes],["◉","Просмотры",row.views],["●","Комментарии",row.comments],["↗","Репосты",row.reposts],["%","ER",`${row.engagementRate.toLocaleString("ru-RU",{maximumFractionDigits:2})}%`]].forEach(([icon,label,value])=>{const item=make("div");item.append(make("i","",icon),make("span","",label),make("b","",typeof value==="number"?formatCompactNumber(value):value));stats.appendChild(item);});
    card.appendChild(stats);
    const meter=make("div","analytics-meter");const fill=make("span");fill.style.width=`${Math.max(row.posts?4:0,Math.round(row.perPost/best*100))}%`;meter.appendChild(fill);card.appendChild(meter);
    if(row.stale)card.appendChild(make("div","analytics-note","Показан сохранённый результат: VK не обновил данные сейчас."));
    if(row.error)card.appendChild(make("div","analytics-note error",row.error));
    root.appendChild(card);
  });
}

async function loadAnalytics(force=false) {
  if(state.analytics.loading)return;
  if(state.analytics.loaded&&!force){renderAnalytics();return;}
  state.analytics.loading=true;state.analytics.error="";renderAnalytics();
  try{
    const response=await runtimeMessage({type:"get_group_analytics",force});
    state.analytics.groups=Array.isArray(response.groups)?response.groups:[];
    state.analytics.postLimit=Number(response.postLimit)||100;
    state.analytics.error=String(response.blockingError||"");
    state.analytics.loaded=true;
  }catch(error){state.analytics.error=`Не удалось загрузить аналитику: ${error.message}`;}
  finally{state.analytics.loading=false;renderAnalytics();}
}

async function loadAll() {
  const local = await chrome.storage.local.get(["vkr_waiting_posts","vkr_posts_history","vkr_scheduled_comments","vkr_user_groups"]);
  state.waiting=(Array.isArray(local.vkr_waiting_posts)?local.vkr_waiting_posts:[]).map((item)=>({...item,draft:VkrWaitingDraftCore.normalizeDraft(item.draft,{defaultText:item.post?.text||""})}));
  state.history=(Array.isArray(local.vkr_posts_history)?local.vkr_posts_history:[]).sort((first,second)=>(Number(second.timestamp)||0)-(Number(first.timestamp)||0));
  const managed=Array.isArray(local.vkr_user_groups)?local.vkr_user_groups:[];
  state.configuredGroupIds=[...new Set(managed.map((group)=>Math.abs(Number(group.id))))].filter((groupId)=>Number.isSafeInteger(groupId)&&groupId>0).sort((first,second)=>first-second);
  const nextDirectorySignature=state.configuredGroupIds.join(",");
  if(nextDirectorySignature!==groupDirectorySignature){groupDirectorySignature=nextDirectorySignature;groupDirectoryLoaded=false;state.groupPhotos={};state.groupScreenNames={};state.analytics.loaded=false;}
  state.groupLabels=Object.fromEntries(managed.map((group)=>[String(group.id),group.name||"club"+group.id]));
  if(!groupDirectoryLoaded){
    try{
      const directory=await runtimeMessage({type:"list_clip_groups"});
      for(const group of directory.groups||[]){
        const id=String(Math.abs(Number(group.id)));
        if(id!=="NaN"){
          if(group.name)state.groupLabels[id]=String(group.name);
          if(group.photoUrl)state.groupPhotos[id]=String(group.photoUrl);
          if(group.screenName)state.groupScreenNames[id]=String(group.screenName);
        }
      }
    }catch{/* сохранённые подписи остаются рабочим fallback */}
    groupDirectoryLoaded=true;
  }
  const queue=await runtimeMessage({type:"get_queue_status"});
  let serverPosts=[];try{const server=await runtimeMessage({type:"list_scheduled_posts"});serverPosts=server.jobs||[];}catch{/* Render may be waking up; local cards remain visible */}
  state.posts=sortPostJobs([...(queue.queue||[]),...serverPosts]); state.pause=queue.pause||null;
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
    const summary=VkrWaitingDraftCore.describeDraft(item.draft,state.groupLabels);
    const {card,body}=baseCard({title:`wall${item.post?.owner_id}_${item.post?.id}`,status:"queued",text:item.post?.text||"Пост без текста",meta:`Добавлен ${formatDate(item.addedAt)} · ${summary.timeText}`,images:postPhotos(item.post,item.photoDataUrls)});
    body.appendChild(make("div","waiting-draft-summary",`Выбрано: ${summary.groupsText}`));
    const root=actions(body);addButton(root,"Настроить публикацию",()=>openPublish(item),"primary");addButton(root,"Открыть исходный пост в VK",()=>chrome.tabs.create({url:item.url||`https://vk.ru/wall${item.post?.owner_id}_${item.post?.id}`}));addButton(root,"Убрать",async()=>{state.waiting=state.waiting.filter((candidate)=>candidate.id!==item.id);await chrome.storage.local.set({vkr_waiting_posts:state.waiting});updateCounts();render();},"danger");$("cards").appendChild(card);
  }
}

function renderPosts() {
  if(!state.posts.length)return empty("Очередь постов пуста.");
  for(const job of sortPostJobs(state.posts)){
    const progress=job.progress||{};const displayStatus=(progress.ok||0)>0&&(progress.fail||0)>0?"partial":job.status;const {card,body}=baseCard({title:job.label||`Пост #${job.post?.id||job.sourcePostId||"?"}`,status:displayStatus,text:job.post?.text||job.text||"",meta:`${formatDate(job.publishAt||postJobTime(job))} · групп ${job.groups?.length||0} · успешно ${progress.ok||0}, ошибок ${progress.fail||0}`,error:job.error||job.lastError,images:postPhotos(job.post,job.previewImages)});
    card.dataset.jobId=job.id;
    if(state.pause?.jobId===job.id)card.classList.add("paused-target");
    appendPublishResults(body,job.results);
    appendPendingPostTargets(body,job);
    if(job.source==="server"&&job.status==="queued"){body.appendChild(make("div","media-schedule-note native-schedule-note",`Render загрузит фотографии в фактическое время ${formatDate(job.publishAt||job.pubDate)} и сразу опубликует пост. Компьютер можно выключить.`));}
    appendPostProgress(body,job);
    if(job.source==="server"&&["queued","processing","paused","failed"].includes(job.status)){const root=actions(body);if(["queued","paused","failed"].includes(job.status))addButton(root,"Редактировать",()=>openPostEdit(job),"primary");if(["paused","failed"].includes(job.status))addButton(root,"Повторить",async()=>{await runtimeMessage({type:"retry_scheduled_post",id:job.id});await loadAll();});addButton(root,job.status==="processing"?"Остановить":"Отменить",async()=>{if(confirm("Отменить эту серверную публикацию? Текущий запрос VK может успеть завершиться.")){await runtimeMessage({type:"cancel_scheduled_post",id:job.id});toast("Серверная публикация отменена.");await loadAll();}},"danger");if(job.sourceUrl)addButton(root,"Исходный пост",()=>chrome.tabs.create({url:job.sourceUrl}));}
    else if(["queued","processing","paused"].includes(job.status)&&job.pauseReason!=="ambiguous_repost"&&!job.cancelRequested){const root=actions(body);addButton(root,job.status==="processing"?"Остановить":"Отменить",async()=>{if(confirm("Отменить эту публикацию?")){const result=await runtimeMessage({type:"cancel_publish_job",jobId:job.id});toast(result.requested?"Остановка запрошена. Текущий запрос завершится, затем очередь остановится.":"Публикация отменена.","info");await loadAll();}},"danger");}
    if(job.status==="paused"&&job.pauseReason==="ambiguous_repost"){
      const root=actions(body);addButton(root,"Уже есть — пропустить",async()=>{await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"skip"});await loadAll();},"primary");addButton(root,"Нет — повторить",async()=>{if(confirm("Вы проверили стену и репоста точно нет?")){await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"retry"});await loadAll();}});addButton(root,"Отменить",async()=>{await runtimeMessage({type:"resolve_ambiguous_repost",jobId:job.id,action:"cancel"});await loadAll();},"danger");
    }
    $("cards").appendChild(card);
  }
}

function renderComments() {
  if(!state.comments.length)return empty("Нет отложенных комментариев.");
  for(const job of state.comments){const groupId=Math.abs(Number(job.groupId));const error=job.lastError?`${job.lastErrorCode?`VK ${job.lastErrorCode}: `:""}${job.lastError}`:null;const {card,body}=baseCard({title:`${groupName(groupId)} · пост ${job.postId}`,status:job.status,text:job.commentText,meta:`club${groupId} · выполнить ${formatDate(job.commentAt)}${job.attempts?` · попыток ${job.attempts}`:""}`,error});if(!job.local&&["queued","paused","failed"].includes(job.status)){const root=actions(body);addButton(root,"Редактировать",()=>openCommentEdit(job),"primary");if(["paused","failed"].includes(job.status))addButton(root,"Повторить",async()=>{await runtimeMessage({type:"retry_scheduled_comment",id:job.id});toast("Комментарий снова поставлен в очередь.");await loadAll();});addButton(root,"Удалить",async()=>{if(confirm("Удалить отложенный комментарий?")){await runtimeMessage({type:"delete_scheduled_comment",id:job.id});await loadAll();}},"danger");}$("cards").appendChild(card);}
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

function maintenanceRecords() {
  const local=[...state.posts.filter(terminal),...state.history,...state.clips.filter(terminal)];
  const comments=state.comments.filter((item)=>!item.local&&terminal(item));
  const stories=state.stories.filter(terminal);
  return {local,comments,stories,all:[...local,...comments,...stories]};
}

function updateMaintenanceStats() {
  const records=maintenanceRecords();
  $("maintenance-local-count").textContent=String(records.local.length);
  $("maintenance-comment-count").textContent=String(records.comments.length);
  $("maintenance-story-count").textContent=String(records.stories.length);
  $("maintenance-error-count").textContent=String(records.all.filter(hasRecordError).length);
}

function maintenanceButtons() {
  return [$("maintenance-errors"),$("maintenance-completed"),$("maintenance-all")];
}

function openMaintenanceDialog() {
  const status=$("maintenance-status");
  status.hidden=true;status.textContent="";status.classList.remove("has-warning");
  updateMaintenanceStats();
  $("maintenance-dialog").showModal();
}

async function runMaintenance(scope) {
  const labels={errors:"завершённые записи с ошибками",completed:"успешно завершённые записи",all:"всю завершённую историю"};
  if(!confirm(`Удалить ${labels[scope]}?\n\nОжидающие, выполняющиеся и приостановленные задания удалены не будут.`))return;
  const buttons=maintenanceButtons();buttons.forEach((button)=>{button.disabled=true;});
  const status=$("maintenance-status");status.hidden=false;status.classList.remove("has-warning");status.textContent="Очищаю локальные данные и MongoDB…";
  try{
    const result=await runtimeMessage({type:"purge_maintenance",scope});
    const localCount=Object.entries(result.local||{}).reduce((sum,[key,value])=>sum+(key==="analyticsCache"?0:(Number(value)||0)),0);
    const postCount=Number(result.posts?.removedJobs)||0;
    const commentCount=Number(result.comments?.removedJobs)||0;
    const storyCount=Number(result.stories?.removedJobs)||0;
    const mediaCount=Number(result.stories?.removedMedia)||0;
    const total=localCount+postCount+commentCount+storyCount;
    const warnings=Array.isArray(result.warnings)?result.warnings:[];
    status.textContent=`${total?`Удалено записей: ${total}.`:`Подходящих завершённых записей не найдено.`}${mediaCount?` Файлов Историй из GridFS: ${mediaCount}.`:""}${warnings.length?`\n${warnings.join("\n")}`:""}`;
    status.classList.toggle("has-warning",warnings.length>0);
    toast(warnings.length?"Локальные данные очищены, но сервер ответил не на всё.":"Очистка данных завершена.",warnings.length?"error":"info");
    if(scope==="all"){state.analytics.loaded=false;state.analytics.groups=[];}
    await loadAll();updateMaintenanceStats();
  }catch(error){status.textContent=`Очистка не завершена: ${error.message}`;status.classList.add("has-warning");toast(error.message,"error");}
  finally{buttons.forEach((button)=>{button.disabled=false;});}
}

const tabInfo={waiting:["Ожидания","Посты, которые вы отметили во ВКонтакте"],posts:["Очередь постов","Сначала ближайшие активные задания, затем завершённые — от новых к старым"],comments:["Комментарии 24/7","Серверные и локальные отложенные комментарии"],stories:["Истории","Отложенные истории сообществ с превью"],clips:["Клипы","Одна видимая вкладка VK на публикацию"],history:["История и аналитика","Результаты публикаций и сравнение активности сообществ"]};
function render(){const cards=$("cards");cards.replaceChildren();const [title,hint]=tabInfo[state.tab];$("section-title").textContent=title;$("section-hint").textContent=hint;$("clear-finished").hidden=state.tab!=="posts";$("analytics-panel").hidden=state.tab!=="history";if(state.tab==="history")renderAnalytics();({waiting:renderWaiting,posts:renderPosts,comments:renderComments,stories:renderStories,clips:renderClips,history:renderHistory})[state.tab]();}

async function saveWaitingDraft(){if(!selectedWaitingId)return;const data=await chrome.storage.local.get("vkr_waiting_posts");const items=Array.isArray(data.vkr_waiting_posts)?data.vkr_waiting_posts:[];const groups=[...document.querySelectorAll('input[name="publish-group"]:checked')].map((input)=>Number(input.value));const draft=VkrWaitingDraftCore.normalizeDraft({groups,mode:$("publish-mode").value,text:$("publish-text").value,commentText:$("publish-comment").value,pubDateLocal:$("publish-date").value,updatedAt:Date.now()});const updated=items.map((item)=>item.id===selectedWaitingId?{...item,draft}:item);await chrome.storage.local.set({vkr_waiting_posts:updated});state.waiting=updated.map((item)=>({...item,draft:VkrWaitingDraftCore.normalizeDraft(item.draft,{defaultText:item.post?.text||""})}));}

async function openPublish(item){selectedWaitingId=item.id;const draft=VkrWaitingDraftCore.normalizeDraft(item.draft,{defaultText:item.post?.text||""});$("publish-text").value=draft.text;$("publish-comment").value=draft.commentText;$("publish-date").value=draft.pubDateLocal;$("publish-mode").value=draft.mode;$("dialog-preview").textContent=item.post?.text||"Пост без текста";const data=await chrome.storage.local.get("vkr_user_groups");const directory=new Map((Array.isArray(data.vkr_user_groups)?data.vkr_user_groups:[]).map((group)=>[String(group.id),group.name||`club${group.id}`]));const root=$("publish-groups");root.replaceChildren();for(const [groupId,name] of directory){const label=make("label");const input=make("input");input.type="checkbox";input.name="publish-group";input.value=groupId;input.checked=draft.groups.includes(Number(groupId));input.addEventListener("change",()=>void saveWaitingDraft());label.append(input,document.createTextNode(` ${name}`));root.appendChild(label);}if(!root.children.length)root.appendChild(make("div","meta","Подключите пользовательский токен и обновите список сообществ в настройках."));$("publish-dialog").showModal();}

async function submitPublish(event){event.preventDefault();await saveWaitingDraft();const groups=[...document.querySelectorAll('input[name="publish-group"]:checked')].map((input)=>Number(input.value));if(!groups.length)return toast("Выберите хотя бы одно сообщество.","error");const data=await chrome.storage.local.get(["vkr_waiting_posts","vk_token"]);const item=(data.vkr_waiting_posts||[]).find((candidate)=>candidate.id===selectedWaitingId);if(!item)return toast("Пост больше не найден.","error");const mode=$("publish-mode").value;if(!data.vk_token)return toast("Подключите пользовательский токен.","error");const pubDate=$("publish-date").value?new Date($("publish-date").value).getTime():null;if(pubDate&&pubDate<=Date.now())return toast("Дата должна быть в будущем.","error");const button=$("publish-submit");button.disabled=true;try{await runtimeMessage({type:"enqueue_publish",post:item.post,groups,mode,text:mode==="copy"?$("publish-text").value:"",pubDate,scheduleMode:pubDate?"server_user":"immediate",processedPhotos:[],autoCommentText:$("publish-comment").value.trim(),label:`Пост из ожиданий #${item.post?.id||"?"}`});state.waiting=(data.vkr_waiting_posts||[]).filter((candidate)=>candidate.id!==item.id);await chrome.storage.local.set({vkr_waiting_posts:state.waiting});$("publish-dialog").close();selectedWaitingId=null;toast(pubDate?"Пост передан на Render и выйдет автоматически.":"Пост добавлен в последовательную очередь.");await loadAll();}finally{button.disabled=false;}}

async function resumePublishQueue() {
  const result=await runtimeMessage({type:"resume_publish_queue"});
  if(result.requiresDecision){toast(result.message||"Сначала решите, что делать со спорным репостом.","error");showPausedJob();return;}
  state.pause=null;updatePauseAlert();toast("Локальная очередь продолжена.");await loadAll();
}

async function init(){
  document.querySelectorAll(".tabs button").forEach((button)=>button.onclick=()=>selectTab(button.dataset.tab));
  document.querySelectorAll("[data-analytics-days]").forEach((button)=>button.onclick=()=>{state.analytics.days=Number(button.dataset.analyticsDays)||0;renderAnalytics();});
  $("analytics-refresh").onclick=()=>void loadAnalytics(true);
  $("refresh").onclick=async()=>{await loadAll();if(state.tab==="history")await loadAnalytics(true);};
  $("settings").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("popup.html")});
  $("new-story").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("stories.html")});
  $("new-clips").onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL("clips.html")});
  $("cleanup-data").onclick=openMaintenanceDialog;
  $("maintenance-close").onclick=()=>$("maintenance-dialog").close();
  $("edit-close").onclick=()=>{$("edit-dialog").close();selectedEdit=null;};
  $("edit-form").onsubmit=submitEdit;
  $("maintenance-errors").onclick=()=>runMaintenance("errors");
  $("maintenance-completed").onclick=()=>runMaintenance("completed");
  $("maintenance-all").onclick=()=>runMaintenance("all");
  $("close-dialog").onclick=async()=>{await saveWaitingDraft();$("publish-dialog").close();selectedWaitingId=null;render();};
  $("publish-form").onsubmit=submitPublish;
  ["publish-text","publish-comment","publish-date","publish-mode"].forEach((id)=>$(id).addEventListener("change",()=>void saveWaitingDraft()));
  $("pause-open-vk").onclick=()=>chrome.tabs.create({url:"https://vk.ru/"});
  $("pause-open-job").onclick=showPausedJob;
  $("resume").onclick=resumePublishQueue;
  $("clear-finished").onclick=async()=>{await runtimeMessage({type:"clear_finished_queue"});await loadAll();};
  chrome.storage.onChanged.addListener((changes,areaName)=>{
    if(areaName!=="local")return;
    if("vkr_queue_pause" in changes){state.pause=changes.vkr_queue_pause.newValue||null;updatePauseAlert();}
    if("vkr_publish_queue" in changes){state.posts=sortPostJobs(Array.isArray(changes.vkr_publish_queue.newValue)?changes.vkr_publish_queue.newValue:[]);updateCounts();if(state.tab==="posts")render();}
  });
  await loadAll();
  setInterval(loadAll,15_000);
}
document.addEventListener("DOMContentLoaded",()=>void init().catch((error)=>toast(error.message,"error")));
