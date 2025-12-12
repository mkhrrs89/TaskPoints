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
    if (menu) {
      menu.addEventListener('click', (e) => e.stopPropagation());
      menu.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    }

    const handleToggle = (event) => {
      event.preventDefault();
      event.stopPropagation();

      const isOpening = !dropdown.classList.contains('open');
      closeAllDropdowns(isOpening ? dropdown : null);

      dropdown.classList.toggle('open');
      toggle.setAttribute('aria-expanded', dropdown.classList.contains('open') ? 'true' : 'false');
    };

    toggle.addEventListener('click', handleToggle);

    // iOS sometimes prefers pointer events over touchstart
    toggle.addEventListener('pointerdown', handleToggle, { passive: false });
  });

  document.addEventListener('click', () => {
    closeAllDropdowns();
  });

  document.addEventListener('touchstart', (event) => {
    if (event.target.closest('.dropdown')) return;
    closeAllDropdowns();
  }, { passive: true });

  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') closeAllDropdowns();
  });
});
