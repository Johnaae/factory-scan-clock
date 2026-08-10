'use strict';

/** Simple bilingual dictionary — English / Spanish. Easy to extend. */
(function initI18n(root) {
  const DICTS = {
    en: {
      'app.title': 'Factory Scan Clock',
      'nav.manager': 'Manager',
      'nav.dashboard': 'Main Dashboard',
      'tank.management': 'Tank Management',
      'tank.number': 'Tank Number',
      'tank.description': 'Description',
      'tank.customer': 'Customer',
      'tank.model': 'Model',
      'tank.priority': 'Priority',
      'tank.dueDate': 'Due Date',
      'tank.notes': 'Notes',
      'tank.pieces': 'Piece Count',
      'tank.status': 'Status',
      'tank.waiting': 'Waiting',
      'tank.active': 'Active',
      'tank.completed': 'Completed',
      'tank.add': 'Add Tank',
      'tank.edit': 'Edit',
      'tank.printSelected': 'Print Selected',
      'tank.printAll': 'Print All',
      'daily.summary': 'Daily Summary',
      'kiosk.scanTeam': 'Scan team barcode',
      'kiosk.resume': 'Resume',
      'kiosk.pause': 'Pause',
      'kiosk.break': 'Break',
      'kiosk.lunch': 'Lunch',
      'kiosk.downtime': 'Downtime',
      'kiosk.endShift': 'End Shift',
      'kiosk.pieceComplete': 'Piece Complete',
      'kiosk.tankComplete': 'Tank Complete',
      'kiosk.correction': 'Correction',
      'kiosk.notes': 'Notes',
      'kiosk.changePhase': 'Change Phase',
      'lang.english': 'English',
      'lang.spanish': 'Español',
      'error.retry': 'Retry',
      'common.save': 'Save',
      'common.cancel': 'Cancel',
      'common.refresh': 'Refresh',
    },
    es: {
      'app.title': 'Factory Scan Clock',
      'nav.manager': 'Gerente',
      'nav.dashboard': 'Panel Principal',
      'tank.management': 'Gestión de Tanques',
      'tank.number': 'Número de Tanque',
      'tank.description': 'Descripción',
      'tank.customer': 'Cliente',
      'tank.model': 'Modelo',
      'tank.priority': 'Prioridad',
      'tank.dueDate': 'Fecha de Entrega',
      'tank.notes': 'Notas',
      'tank.pieces': 'Cantidad de Piezas',
      'tank.status': 'Estado',
      'tank.waiting': 'En Espera',
      'tank.active': 'Activo',
      'tank.completed': 'Completado',
      'tank.add': 'Agregar Tanque',
      'tank.edit': 'Editar',
      'tank.printSelected': 'Imprimir Seleccionados',
      'tank.printAll': 'Imprimir Todos',
      'daily.summary': 'Resumen Diario',
      'kiosk.scanTeam': 'Escanear código de equipo',
      'kiosk.resume': 'Reanudar',
      'kiosk.pause': 'Pausa',
      'kiosk.break': 'Descanso',
      'kiosk.lunch': 'Almuerzo',
      'kiosk.downtime': 'Tiempo muerto',
      'kiosk.endShift': 'Fin de Turno',
      'kiosk.pieceComplete': 'Pieza Completa',
      'kiosk.tankComplete': 'Tanque Completo',
      'kiosk.correction': 'Corrección',
      'kiosk.notes': 'Notas',
      'kiosk.changePhase': 'Cambiar Fase',
      'lang.english': 'English',
      'lang.spanish': 'Español',
      'error.retry': 'Reintentar',
      'common.save': 'Guardar',
      'common.cancel': 'Cancelar',
      'common.refresh': 'Actualizar',
    },
  };

  const STORAGE_KEY = 'factory_scan_lang';
  let lang = 'en';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'es' || saved === 'en') lang = saved;
  } catch (_e) {
    /* ignore */
  }

  function t(key, fallback) {
    const dict = DICTS[lang] || DICTS.en;
    return dict[key] || (DICTS.en[key] || fallback || key);
  }

  function setLang(next) {
    lang = next === 'es' ? 'es' : 'en';
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (_e) {
      /* ignore */
    }
    document.documentElement.lang = lang;
    applyDom();
    root.dispatchEvent(new CustomEvent('factory-lang-change', { detail: { lang } }));
  }

  function getLang() {
    return lang;
  }

  function applyDom(rootEl) {
    const scope = rootEl || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      el.textContent = t(key, el.textContent);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) el.setAttribute('placeholder', t(key));
    });
  }

  function mountSelector(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<label class="lang-select-label"><span data-i18n="lang.english">Language</span>
      <select id="factoryLangSelect" aria-label="Language">
        <option value="en">${t('lang.english')}</option>
        <option value="es">${t('lang.spanish')}</option>
      </select></label>`;
    const sel = el.querySelector('#factoryLangSelect');
    if (sel) {
      sel.value = lang;
      sel.addEventListener('change', () => setLang(sel.value));
    }
  }

  root.FactoryI18n = { t, setLang, getLang, applyDom, mountSelector, DICTS };
  document.documentElement.lang = lang;
})(window);
