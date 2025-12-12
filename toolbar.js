function closeAllDropdowns(exception) {
  document.querySelectorAll('.dropdown.open').forEach((dropdown) => {
    if (dropdown === exception) return;
    dropdown.classList.remove('open');
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.dropdown').forEach((dropdown) => {
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    if (!toggle) return;

    const menu = dropdown.querySelector('.dropdown-menu');

    // Prevent taps inside menu from closing it
    if (menu) {
      menu.addEventListener('pointerdown', (e) => e.stopPropagation());
      menu.addEventListener('click', (e) => e.stopPropagation());
    }

    function setExpanded(isOpen) {
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    function doToggle(e) {
      e.preventDefault();
      e.stopPropagation();

      const isOpening = !dropdown.classList.contains('open');
      closeAllDropdowns(isOpening ? dropdown : null);

      dropdown.classList.toggle('open');
      setExpanded(dropdown.classList.contains('open'));
    }

    // Use pointerdown for mobile reliability
    toggle.addEventListener('pointerdown', (e) => {
      // mark that this tap already handled, so the synthetic click is ignored
      toggle.dataset.ignoreClick = '1';
      doToggle(e);
      setTimeout(() => delete toggle.dataset.ignoreClick, 350);
    });

    // Keep click for desktop keyboards/etc, but ignore if it followed a pointer tap
    toggle.addEventListener('click', (e) => {
      if (toggle.dataset.ignoreClick) return;
      doToggle(e);
    });
  });

  // Close when tapping/clicking outside
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dropdown')) return;
    closeAllDropdowns();
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') closeAllDropdowns();
  });
});
