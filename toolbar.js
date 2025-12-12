function closeAllDropdowns(exception) {
  document.querySelectorAll('.dropdown.open').forEach((dropdown) => {
    if (dropdown === exception) return;
    dropdown.classList.remove('open');
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.dropdown').forEach((dropdown) => {
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    if (!toggle) return;

    const handleToggle = (event) => {
      event.stopPropagation();
      const isOpening = !dropdown.classList.contains('open');
      closeAllDropdowns(isOpening ? dropdown : null);
      dropdown.classList.toggle('open');
      toggle.setAttribute('aria-expanded', dropdown.classList.contains('open'));
    };

    toggle.addEventListener('click', handleToggle);
    toggle.addEventListener('touchstart', (event) => {
      event.preventDefault();
      handleToggle(event);
    }, { passive: false });
  });

  document.addEventListener('click', () => {
    closeAllDropdowns();
  });

  document.addEventListener('touchstart', () => {
    closeAllDropdowns();
  });

  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') {
      closeAllDropdowns();
    }
  });
});
