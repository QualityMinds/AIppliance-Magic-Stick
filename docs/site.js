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
    const selectTab = (tab, focus = false) => {
      tabs.forEach((candidate, index) => {
        const selected = candidate === tab;
        candidate.setAttribute('aria-selected', String(selected));
        candidate.tabIndex = selected ? 0 : -1;
        panels[index].hidden = !selected;
      });
      if (focus) tab.focus();
    };
    controls.hidden = false;
    selectTab(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0]);
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(tab));
      tab.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          selectTab(tabs[next], true);
        }
      });
    });
  }
})();
