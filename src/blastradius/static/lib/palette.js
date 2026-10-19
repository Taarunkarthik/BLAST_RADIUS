/**
 * Command palette for the BlastRadius shell.
 *
 * Markup lives in index.html (`#palette-overlay`, `#palette-input`,
 * `#palette-list`, `#palette-trigger`). This module is the only behaviour:
 * filtering, arrow-key navigation, Enter to run, Escape to close and
 * Ctrl/Cmd-K to toggle. Commands are supplied by app.js so the palette never
 * reaches into the router or store directly.
 *
 * Command shape:
 *   { label: string, meta?: string, keywords?: string, run: () => void }
 */

const $ = id => document.getElementById(id);

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function createCommandPalette({ getCommands, onOpen, onClose } = {}) {
  const overlay = $('palette-overlay');
  const input = $('palette-input');
  const list = $('palette-list');
  const trigger = $('palette-trigger');

  if (!overlay || !input || !list) {
    // The shell markup should always exist; degrade to a no-op if it does not.
    return {
      open() {},
      close() {},
      toggle() {},
      isOpen: () => false,
    };
  }

  let commands = [];
  let filtered = [];
  let active = 0;
  let returnFocus = null;
  let open = false;

  input.setAttribute('aria-expanded', 'false');

  function isOpen() {
    return open;
  }

  function matches(command, query) {
    if (!query) return true;
    const haystack = [command.label, command.meta, command.keywords]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    filtered = commands.filter(command => matches(command, query));
    if (active >= filtered.length) active = Math.max(filtered.length - 1, 0);

    list.replaceChildren();

    if (!filtered.length) {
      const empty = document.createElement('li');
      empty.className = 'palette-empty';
      empty.textContent = `No command matches “${input.value}”.`;
      list.append(empty);
      input.setAttribute('aria-activedescendant', '');
      return;
    }

    filtered.forEach((command, index) => {
      const item = document.createElement('li');
      item.id = `palette-option-${index}`;
      item.className = index === active ? 'palette-item is-active' : 'palette-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === active ? 'true' : 'false');

      const number = document.createElement('span');
      number.className = 'p-num';
      number.textContent = pad2(index + 1);

      const label = document.createElement('span');
      label.className = 'p-label';
      label.textContent = command.label;

      const meta = document.createElement('span');
      meta.className = 'p-meta';
      meta.textContent = command.meta || '';

      item.append(number, label, meta);
      item.addEventListener('mouseenter', () => {
        active = index;
        paintSelection(false);
      });
      item.addEventListener('click', () => execute(index));
      list.append(item);
    });

    input.setAttribute('aria-activedescendant', `palette-option-${active}`);
  }

  function paintSelection(scroll) {
    const items = list.querySelectorAll('.palette-item');
    items.forEach((item, index) => {
      const selected = index === active;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    if (!filtered.length) return;
    input.setAttribute('aria-activedescendant', `palette-option-${active}`);
    if (scroll) {
      const current = list.querySelector('.palette-item.is-active');
      if (current) current.scrollIntoView({ block: 'nearest' });
    }
  }

  function execute(index) {
    const command = filtered[index];
    if (!command) return;
    closePalette(false);
    command.run();
  }

  function openPalette() {
    if (open) return;
    returnFocus = document.activeElement;
    commands = typeof getCommands === 'function' ? getCommands() : [];
    input.value = '';
    active = 0;
    render();
    open = true;
    overlay.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    document.body.classList.add('palette-open');
    if (typeof onOpen === 'function') onOpen();
    window.requestAnimationFrame(() => input.focus());
  }

  function closePalette(restoreFocus = true) {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-activedescendant', '');
    document.body.classList.remove('palette-open');
    if (restoreFocus && returnFocus && typeof returnFocus.focus === 'function') {
      returnFocus.focus();
    }
    if (typeof onClose === 'function') onClose();
  }

  function toggle() {
    if (open) closePalette(true);
    else openPalette();
  }

  input.addEventListener('input', () => {
    active = 0;
    render();
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length) {
        active = (active + 1) % filtered.length;
        paintSelection(true);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length) {
        active = (active - 1 + filtered.length) % filtered.length;
        paintSelection(true);
      }
    } else if (event.key === 'Home') {
      event.preventDefault();
      active = 0;
      paintSelection(true);
    } else if (event.key === 'End') {
      event.preventDefault();
      active = Math.max(filtered.length - 1, 0);
      paintSelection(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      execute(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePalette(true);
    } else if (event.key === 'Tab') {
      // The palette owns focus while open: keep Tab inside the dialog.
      event.preventDefault();
      input.focus();
    }
  });

  overlay.addEventListener('mousedown', event => {
    if (event.target === overlay) closePalette(true);
  });

  if (trigger) trigger.addEventListener('click', openPalette);

  document.addEventListener('keydown', event => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      toggle();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closePalette(true);
    }
  });

  return {
    open: openPalette,
    close: closePalette,
    toggle,
    isOpen,
  };
}
