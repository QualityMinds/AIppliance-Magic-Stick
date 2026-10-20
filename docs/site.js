// SPDX-License-Identifier: BUSL-1.1
(() => {
  const menu = document.querySelector('.menu-toggle');
  const navigation = document.querySelector('#main-navigation');
  if (menu && navigation) {
    menu.hidden = false;
    navigation.dataset.collapsed = 'true';
    const closeMenu = () => {
      menu.setAttribute('aria-expanded', 'false');
      navigation.dataset.collapsed = 'true';
    };
    menu.addEventListener('click', () => {
      const expanded = menu.getAttribute('aria-expanded') !== 'true';
      menu.setAttribute('aria-expanded', String(expanded));
      navigation.dataset.collapsed = String(!expanded);
    });
    navigation.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        closeMenu();
        menu.focus();
      }
    });
  }

  for (const tour of document.querySelectorAll('[data-tabs]')) {
    const controls = tour.querySelector('[role="tablist"]');
    if (!controls) continue;
    const tabs = [...controls.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
    // Leave every panel readable if the markup is incomplete or JavaScript is off.
    if (!tabs.length || panels.some((panel) => !panel || !tour.contains(panel))) continue;
    const caption = tour.querySelector('[data-tab-caption]');
    const vertical = controls.getAttribute('aria-orientation') === 'vertical';
    const selectTab = (tab, focus = false) => {
      tabs.forEach((candidate, index) => {
        const selected = candidate === tab;
        candidate.setAttribute('aria-selected', String(selected));
        candidate.tabIndex = selected ? 0 : -1;
        panels[index].hidden = !selected;
      });
      if (caption && tab.dataset.caption) caption.textContent = tab.dataset.caption;
      if (focus) tab.focus();
    };
    controls.hidden = false;
    selectTab(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0]);
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(tab));
      tab.addEventListener('keydown', (event) => {
        let next;
        if (event.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next = (index + 1) % tabs.length;
        if (event.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          selectTab(tabs[next], true);
        }
      });
    });
  }

  // Product video: the poster is a plain link to YouTube; with JavaScript a click
  // replaces it with the youtube-nocookie.com player instead. Nothing from
  // YouTube is loaded before the click.
  const videoLabels = {
    en: {
      title: 'Magic Stick at a glance: manage AI models centrally and stay in control (German)',
      loading: 'Loading the YouTube player. If playback does not start, use the link below the video.',
      loaded: 'YouTube player loaded.',
    },
    de: {
      title: 'Magic Stick im Überblick: KI-Modelle zentral verwalten und selbst kontrollieren',
      loading: 'YouTube-Player wird geladen. Falls die Wiedergabe nicht startet, nutze den Link unter dem Video.',
      loaded: 'YouTube-Player geladen.',
    },
  };
  const language = document.documentElement.lang === 'de' ? 'de' : 'en';
  for (const frame of document.querySelectorAll('[data-video]')) {
    const trigger = frame.querySelector('[data-video-play]');
    const status = frame.parentElement.querySelector('[data-video-status]');
    if (!trigger || !/^[\w-]{11}$/.test(frame.dataset.video)) continue;
    trigger.setAttribute('role', 'button');
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      const labels = videoLabels[language];
      const player = document.createElement('iframe');
      player.title = labels.title;
      player.src = `https://www.youtube-nocookie.com/embed/${frame.dataset.video}?autoplay=1&playsinline=1&rel=0&hl=${language}`;
      player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      player.allowFullscreen = true;
      player.referrerPolicy = 'strict-origin-when-cross-origin';
      if (status) status.textContent = labels.loading;
      player.addEventListener('load', () => { if (status) status.textContent = labels.loaded; }, { once: true });
      frame.replaceChildren(player);
      player.focus();
    }, { once: true });
  }
})();
