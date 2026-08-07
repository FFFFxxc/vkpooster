(function() {
  if (window.__vkr_main_world_handler_installed) return;
  window.__vkr_main_world_handler_installed = true;

  // Патч history для отслеживания переходов в SPA
  try {
    const pushState = history.pushState;
    history.pushState = function() {
      const ret = pushState.apply(this, arguments);
      window.dispatchEvent(new Event('pushstate'));
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    };
    const replaceState = history.replaceState;
    history.replaceState = function() {
      const ret = replaceState.apply(this, arguments);
      window.dispatchEvent(new Event('replacestate'));
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    };
  } catch (e) {
    console.error('[VKR] History patch failed:', e);
  }

  console.log("[VKR Main World Injection] Active and listening for messages");

  // Expose showToast directly in page context for console debugging
  window.showToast = function(text, type) {
    // Inject toast keyframes once
    if (!document.getElementById('vkr-bounce-css')) {
      var st = document.createElement('style');
      st.id = 'vkr-bounce-css';
      st.textContent = '@keyframes vkr-bounceInDown{0%{opacity:0;transform:translateY(-120px)}60%{opacity:1;transform:translateY(10px)}80%{transform:translateY(-5px)}100%{opacity:1;transform:translateY(0)}}@keyframes vkr-bounceOutUp{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-120px)}}';
      (document.head || document.documentElement).appendChild(st);
    }

    var colors = {
      success: { 
        bg: 'linear-gradient(135deg, rgba(6, 78, 59, 0.85), rgba(4, 120, 87, 0.85))', 
        border: 'rgba(52, 211, 153, 0.35)',
        shadow: '0 8px 32px rgba(4, 120, 87, 0.25)' 
      },
      error: { 
        bg: 'linear-gradient(135deg, rgba(136, 19, 55, 0.85), rgba(159, 18, 57, 0.85))', 
        border: 'rgba(251, 113, 133, 0.35)',
        shadow: '0 8px 32px rgba(159, 18, 57, 0.25)'
      },
      info: { 
        bg: 'linear-gradient(135deg, rgba(30, 27, 75, 0.85), rgba(67, 56, 202, 0.85))', 
        border: 'rgba(129, 140, 248, 0.35)',
        shadow: '0 8px 32px rgba(67, 56, 202, 0.25)'
      }
    };
    var c = colors[type] || colors.info;
    var existing = document.querySelector('.vkr-toast-notify');
    if (existing) existing.remove();
    var d = document.createElement('div');
    d.className = 'vkr-toast-notify';
    d.style.cssText = 'position:fixed!important;top:20px!important;left:50%!important;translate:-50% 0!important;padding:14px 24px!important;background:' + c.bg + '!important;border:1px solid ' + c.border + '!important;border-radius:12px!important;font-size:14px!important;font-weight:500!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;box-shadow:' + c.shadow + '!important;z-index:999999999!important;animation:vkr-bounceInDown 0.6s cubic-bezier(0.34,1.56,0.64,1) forwards!important;max-width:400px!important;min-width:200px!important;width:auto!important;height:auto!important;min-height:40px!important;max-height:200px!important;white-space:normal!important;text-align:center!important;backdrop-filter:blur(12px)!important;-webkit-backdrop-filter:blur(12px)!important;pointer-events:auto!important;display:flex!important;align-items:center!important;justify-content:center!important;box-sizing:border-box!important;overflow:visible!important;line-height:1.5!important;bottom:auto!important;';
    var sp = document.createElement('span');
    sp.style.cssText = 'display:block!important;color:#fff!important;font-size:14px!important;font-weight:500!important;line-height:1.5!important;text-shadow:0 1px 2px rgba(0,0,0,0.2)!important;opacity:1!important;visibility:visible!important;';
    sp.textContent = text;
    d.appendChild(sp);
    document.body.appendChild(d);
    setTimeout(function() { d.style.setProperty('animation', 'vkr-bounceOutUp 0.35s ease-in forwards', 'important'); setTimeout(function() { d.remove(); }, 400); }, 3000);
  };

  // --- Lottie Animation Support ---
  window.__vkrLottieAnimations = [];

  function loadLottieScript(lottieScriptUrl) {
    return new Promise(function(resolve, reject) {
      if (window.lottie) { resolve(window.lottie); return; }
      var s = document.createElement('script');
      s.src = lottieScriptUrl;
      s.onload = function() { resolve(window.lottie); };
      s.onerror = function() { reject(new Error('Failed to load lottie-player.js')); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function playLottieInContainer(container, jsonUrl, lottieScriptUrl) {
    try {
      var lottie = await loadLottieScript(lottieScriptUrl);
      var anim = lottie.loadAnimation({
        container: container,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: jsonUrl
      });
      window.__vkrLottieAnimations.push(anim);
      return anim;
    } catch (e) {
      console.error('[VKR Lottie] Error:', e);
    }
  }

  window.addEventListener('message', async (event) => {
    var d = event.data || {};

    if (d.type === 'VKR_PLAY_LOTTIE') {
      console.log('[VKR Main World] Lottie request for:', d.containerId);
      var el = document.getElementById(d.containerId);
      if (el && d.lottieScriptUrl) {
        playLottieInContainer(el, d.jsonUrl, d.lottieScriptUrl);
      }
      return;
    }

    if (d.type === 'VKR_DESTROY_LOTTIE') {
      console.log('[VKR Main World] Destroying lottie animations');
      window.__vkrLottieAnimations.forEach(function(a) { a.destroy(); });
      window.__vkrLottieAnimations = [];
      return;
    }

  });
})();
