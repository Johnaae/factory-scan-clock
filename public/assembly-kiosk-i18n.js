'use strict';

/**
 * Assembly kiosk English / Spanish strings. Extends the shared FactoryI18n dictionary
 * (same language selector + saved preference as the Fabrication kiosk).
 * Tank numbers, employee names, team names and barcodes are inserted as-is.
 */
(function initAssemblyI18n(root) {
  const EN = {
    'ak.subtitle': 'Assembly Production',
    'ak.exitKiosk': 'Exit Kiosk',
    'ak.scanTitle': 'Scan Team or Employee',
    'ak.scanSub':
      'Scan a TEAM barcode to add an independent team card. Each team selects its own tank. Lunch / Resume / Employee Out are per team.',
    'ak.scanLabel': 'Scan Team / Employee only',
    'ak.scanPlaceholder': 'TEAM or EMPLOYEE barcode only',
    'ak.scanBtn': 'Scan',
    'ak.hintTeamScan': 'Team scan does not start labor. Confirm tank, then press START.',
    'ak.hintSelectTeam': 'Tap a team card to select it — employee badge scans join the selected team for this shift.',
    'ak.noTeams': 'No teams on this kiosk yet. Scan a TEAM barcode to begin.',
    'ak.returnTitle': 'Return Tank to Assembly',
    'ak.selectRemoved': 'Select removed tank…',
    'ak.returnBtn': 'Return to Assembly',
    'ak.returning': 'Returning…',
    'ak.recentTitle': 'Recently Finished Assembly',
    'ak.confirmTitle': 'Confirm',
    'ak.confirm': 'Confirm',
    'ak.cancel': 'Cancel',
    'ak.employeeOutTitle': 'Employee Out',
    'ak.employeeOutHint': 'Select an employee on this team’s open shift.',
    'ak.employeeOutEmpty': 'No open-shift employees for this team.',
    'ak.confirmOut': 'Confirm Out',

    'ak.status.ready_for_assembly': 'Ready for Assembly',
    'ak.status.assembly_in_progress': 'Assembly Working',
    'ak.status.ready_for_qa': 'Ready for QA',
    'ak.status.qa_in_progress': 'QA In Progress',
    'ak.status.qa_failed': 'QA Failed',
    'ak.status.ready_for_testing': 'Ready for Testing',
    'ak.status.testing_in_progress': 'Testing',

    'ak.tank': 'Tank {tank}',
    'ak.team': 'Team {id}',
    'ak.teamFallback': 'Team',
    'ak.thisTank': 'this tank',
    'ak.optInAssemblyTeams': 'Tank {tank} — In Assembly ({teams})',
    'ak.optInAssembly': 'Tank {tank} — In Assembly',
    'ak.optAlsoTesting': 'Testing also in progress',
    'ak.optAlsoInTesting': 'Tank {tank} — In Testing (Assembly can join)',
    'ak.optRestored': 'Tank {tank} — Restored, Ready for Assembly',
    'ak.optReady': 'Tank {tank} — Ready for Assembly',
    'ak.optTestingPassed': 'Tank {tank} — Testing Passed, Ready for Assembly',
    'ak.optLockedTesting': 'Tank {tank} — LOCKED: In Testing',
    'ak.optLockedTestingFailed': 'Tank {tank} — LOCKED: Failed Testing',
    'ak.lockedTestingTitle': 'In Testing — Assembly Locked',
    'ak.lockedBadge': 'Locked',
    'ak.lockedTestingReason': 'In Testing (QA/QC). Assembly can start after Testing finishes.',
    'ak.lockedTestingFailedReason':
      'Failed Testing — on hold. Assembly is blocked until Retest passes or FAB Rework is complete.',
    'ak.badge.lunch': 'LUNCH',
    'ak.badge.working': 'WORKING',
    'ak.badge.active': 'ACTIVE',
    'ak.badge.selected': 'SELECTED',
    'ak.btn.start': 'START',
    'ak.btn.finish': 'FINISH',
    'ak.btn.remove': 'REMOVE',
    'ak.btn.stop': 'STOP',
    'ak.btn.confirmTank': 'CONFIRM TANK',
    'ak.btn.installBulkhead': 'INSTALL BULKHEAD',
    'ak.btn.resume': 'Resume',
    'ak.btn.lunch': 'Lunch',
    'ak.btn.employeeOut': 'Employee Out',
    'ak.btn.endShift': 'End Shift',
    'ak.btn.restore': 'RESTORE TO ASSEMBLY',
    'ak.bulkhead.title': 'Install Bulkhead',
    'ak.bulkhead.forTank': 'Tank {tank}',
    'ak.bulkhead.searchPh': 'Search bulkhead number…',
    'ak.bulkhead.empty': 'No available bulkheads in inventory.',
    'ak.bulkhead.available': 'Available',
    'ak.bulkhead.confirm': 'Install',
    'ak.bulkhead.installed': 'Bulkhead: {n}',
    'ak.bulkhead.installedMsg': 'Bulkhead {n} installed on this tank.',
    'ak.bulkhead.loadFailed': 'Could not load available bulkheads.',
    'ak.bulkhead.installFailed': 'Could not install bulkhead.',
    'ak.metric.duration': 'Duration',
    'ak.metric.labor': 'Labor',
    'ak.alsoWorking': 'Also working: {teams}',
    'ak.tankTotalLabor': ' · Tank total labor: {labor}',
    'ak.onLunch': 'On lunch — timers paused for this team only',
    'ak.onShift': 'On shift:',
    'ak.noOpenShift': 'No open-shift employees',
    'ak.selectTankForTeam': 'Select tank for team',
    'ak.selectFabTank': 'Select completed FAB tank…',
    'ak.noTankYet': 'No tank confirmed for this team yet.',
    'ak.finishedAt': 'Finished: {ts}',
    'ak.statusLine': 'Status: {status}',

    'ak.msg.selectRemovedFirst': 'Select a removed tank first.',
    'ak.msg.returnTitle': 'Return Tank to Assembly?',
    'ak.msg.returnBody':
      'Tank {tank}\n\nThe tank goes back to the Assembly tank list. It is not sent back to FAB.\nFAB completion, prior Assembly labor and history are preserved.\nNo timer or labor starts until a team confirms the tank and presses START.',
    'ak.msg.returnFailed': 'Could not return the tank to Assembly.',
    'ak.msg.returned': 'Tank {tank} returned to Assembly.',
    'ak.msg.offline': 'Could not reach the server. Check the connection and try again.',
    'ak.msg.teamSelected': '{team} selected — employee scans join this team.',
    'ak.msg.windingRedirect': 'This machine is winding — redirecting…',
    'ak.msg.loadFailed': 'Could not load assembly kiosk.',
    'ak.msg.actionFailed': 'Action failed.',
    'ak.msg.selectTankFirst': 'Select a tank for this team first.',
    'ak.msg.confirmFailed': 'Could not confirm tank.',
    'ak.msg.tankConfirmed': 'Tank confirmed. Press START for labor.',
    'ak.msg.loadEmployeesFailed': 'Could not load employees.',
    'ak.msg.clockOutQuestion': 'Clock out {name}? They leave this team’s active stage labor only.',
    'ak.msg.clockOutFailed': 'Could not clock employee out.',
    'ak.msg.clockedOut': '{name} clocked out.',
    'ak.msg.laborStarted': 'Assembly labor started for this team.',
    'ak.msg.laborStopped': 'Labor stopped.',
    'ak.msg.finishTitle': 'Finish Assembly?',
    'ak.msg.finishOthers':
      "This finishes this team's work on {tank}.\n\nAssembly stays open until the other team(s) also finish: {teams}.",
    'ak.msg.finishLast': 'This ends Assembly for {tank} and sends the tank to Ready for Testing.',
    'ak.msg.finishLastQa': 'This ends Assembly for {tank} and sends the tank to Ready for QA/QC.',
    'ak.msg.finishOk': 'Finish',
    'ak.msg.removeTitle': 'Remove Tank From Assembly?',
    'ak.msg.removeBody':
      '{tank}\n\nThis will remove the tank from the current Assembly schedule.\nProduction history already recorded will be preserved.',
    'ak.msg.removeOk': 'Remove From Assembly',
    'ak.msg.removed': 'Tank removed from the Assembly schedule.',
    'ak.msg.lunchOnCard': 'Lunch must be pressed on a Team Card.',
    'ak.msg.lunchStarted': 'Team lunch — this team paused only.',
    'ak.msg.resumeOnCard': 'Resume must be pressed on a Team Card. Do not rescan the Team barcode.',
    'ak.msg.resumed': 'Team resumed.',
    'ak.msg.outOnCard': 'Employee Out must be pressed on a Team Card.',
    'ak.msg.endShiftOnCard': 'End Shift must be pressed on a Team Card.',
    'ak.msg.endShiftTitle': 'End Shift for this team?',
    'ak.msg.endShiftBody': 'Stops this team’s labor and removes their card from the kiosk.',
    'ak.msg.endShiftDone': 'Team end shift complete.',
    'ak.msg.useButtons': 'Use the buttons for tank actions. Scan only a TEAM or EMPLOYEE barcode here.',
    'ak.msg.scanTeamOrEmployee': 'Scan a Team or Employee barcode only.',
    'ak.msg.teamAssigned':
      'Team assigned. Select a tank from the dropdown and press CONFIRM TANK, then START for labor.',
    'ak.msg.selectedEmployee': 'Selected: {name}',
    'ak.msg.employeeSelected': 'Employee selected.',
    'ak.msg.restoreTitle': 'Restore Tank to Assembly?',
    'ak.msg.restoreBody':
      '{tank} was marked Finish and is waiting for Testing (not started yet).\n\nRestore it to Assembly?',
    'ak.msg.restoreOk': 'Restore',
    'ak.msg.restored': 'Tank restored to the Assembly selection list. Confirm the tank again.',
    'ak.msg.badResponse': 'Invalid server response.',
  };

  const ES = {
    'ak.subtitle': 'Producción de Ensamble',
    'ak.exitKiosk': 'Salir del Kiosco',
    'ak.scanTitle': 'Escanear Equipo o Empleado',
    'ak.scanSub':
      'Escanee el código de un EQUIPO para agregar su tarjeta. Cada equipo elige su propio tanque. Almuerzo / Reanudar / Salida de Empleado son por equipo.',
    'ak.scanLabel': 'Escanear solo Equipo / Empleado',
    'ak.scanPlaceholder': 'Solo código de EQUIPO o EMPLEADO',
    'ak.scanBtn': 'Escanear',
    'ak.hintTeamScan': 'Escanear el equipo no inicia la mano de obra. Confirme el tanque y luego presione INICIAR.',
    'ak.hintSelectTeam':
      'Toque la tarjeta de un equipo para seleccionarla — los gafetes escaneados se unen al equipo seleccionado durante este turno.',
    'ak.noTeams': 'Todavía no hay equipos en este kiosco. Escanee el código de un EQUIPO para comenzar.',
    'ak.returnTitle': 'Regresar Tanque a Ensamble',
    'ak.selectRemoved': 'Seleccione el tanque retirado…',
    'ak.returnBtn': 'Regresar a Ensamble',
    'ak.returning': 'Regresando…',
    'ak.recentTitle': 'Ensamble Terminado Recientemente',
    'ak.confirmTitle': 'Confirmar',
    'ak.confirm': 'Confirmar',
    'ak.cancel': 'Cancelar',
    'ak.employeeOutTitle': 'Salida de Empleado',
    'ak.employeeOutHint': 'Seleccione un empleado del turno abierto de este equipo.',
    'ak.employeeOutEmpty': 'No hay empleados en turno abierto para este equipo.',
    'ak.confirmOut': 'Confirmar Salida',

    'ak.status.ready_for_assembly': 'Listo para Ensamble',
    'ak.status.assembly_in_progress': 'En Ensamble',
    'ak.status.ready_for_qa': 'Listo para QA',
    'ak.status.qa_in_progress': 'QA en Proceso',
    'ak.status.qa_failed': 'QA Rechazado',
    'ak.status.ready_for_testing': 'Listo para Pruebas',
    'ak.status.testing_in_progress': 'En Pruebas',

    'ak.tank': 'Tanque {tank}',
    'ak.team': 'Equipo {id}',
    'ak.teamFallback': 'Equipo',
    'ak.thisTank': 'este tanque',
    'ak.optInAssemblyTeams': 'Tanque {tank} — En Ensamble ({teams})',
    'ak.optInAssembly': 'Tanque {tank} — En Ensamble',
    'ak.optAlsoTesting': 'Pruebas también en curso',
    'ak.optAlsoInTesting': 'Tanque {tank} — En Pruebas (Ensamble puede unirse)',
    'ak.optRestored': 'Tanque {tank} — Restaurado, Listo para Ensamble',
    'ak.optReady': 'Tanque {tank} — Listo para Ensamble',
    'ak.optTestingPassed': 'Tanque {tank} — Pruebas Aprobadas, Listo para Ensamble',
    'ak.optLockedTesting': 'Tanque {tank} — BLOQUEADO: En Pruebas',
    'ak.optLockedTestingFailed': 'Tanque {tank} — BLOQUEADO: Falló Pruebas',
    'ak.lockedTestingTitle': 'En Pruebas — Ensamble Bloqueado',
    'ak.lockedBadge': 'Bloqueado',
    'ak.lockedTestingReason': 'En Pruebas (QA/QC). Ensamble puede iniciar cuando terminen las Pruebas.',
    'ak.lockedTestingFailedReason':
      'Falló Pruebas — en espera. Ensamble está bloqueado hasta que pase la Re-prueba o se complete el Retrabajo en FAB.',
    'ak.badge.lunch': 'ALMUERZO',
    'ak.badge.working': 'TRABAJANDO',
    'ak.badge.active': 'ACTIVO',
    'ak.badge.selected': 'SELECCIONADO',
    'ak.btn.start': 'INICIAR',
    'ak.btn.finish': 'TERMINAR',
    'ak.btn.remove': 'RETIRAR',
    'ak.btn.stop': 'DETENER',
    'ak.btn.confirmTank': 'CONFIRMAR TANQUE',
    'ak.btn.installBulkhead': 'INSTALAR MAMPARO',
    'ak.btn.resume': 'Reanudar',
    'ak.btn.lunch': 'Almuerzo',
    'ak.btn.employeeOut': 'Salida de Empleado',
    'ak.btn.endShift': 'Fin de Turno',
    'ak.btn.restore': 'RESTAURAR A ENSAMBLE',
    'ak.bulkhead.title': 'Instalar Mamparo',
    'ak.bulkhead.forTank': 'Tanque {tank}',
    'ak.bulkhead.searchPh': 'Buscar número de mamparo…',
    'ak.bulkhead.empty': 'No hay mamparos disponibles en inventario.',
    'ak.bulkhead.available': 'Disponible',
    'ak.bulkhead.confirm': 'Instalar',
    'ak.bulkhead.installed': 'Mamparo: {n}',
    'ak.bulkhead.installedMsg': 'Mamparo {n} instalado en este tanque.',
    'ak.bulkhead.loadFailed': 'No se pudieron cargar los mamparos disponibles.',
    'ak.bulkhead.installFailed': 'No se pudo instalar el mamparo.',
    'ak.metric.duration': 'Duración',
    'ak.metric.labor': 'Mano de obra',
    'ak.alsoWorking': 'También trabajando: {teams}',
    'ak.tankTotalLabor': ' · Mano de obra total del tanque: {labor}',
    'ak.onLunch': 'En almuerzo — tiempos en pausa solo para este equipo',
    'ak.onShift': 'En turno:',
    'ak.noOpenShift': 'No hay empleados en turno',
    'ak.selectTankForTeam': 'Seleccionar tanque para el equipo',
    'ak.selectFabTank': 'Seleccione un tanque terminado en FAB…',
    'ak.noTankYet': 'Este equipo todavía no tiene tanque confirmado.',
    'ak.finishedAt': 'Terminado: {ts}',
    'ak.statusLine': 'Estado: {status}',

    'ak.msg.selectRemovedFirst': 'Primero seleccione un tanque retirado.',
    'ak.msg.returnTitle': '¿Regresar el tanque a Ensamble?',
    'ak.msg.returnBody':
      'Tanque {tank}\n\nEl tanque regresa a la lista de tanques de Ensamble. No se regresa a FAB.\nSe conservan la terminación de FAB, la mano de obra previa de Ensamble y el historial.\nNingún tiempo ni mano de obra inicia hasta que un equipo confirme el tanque y presione INICIAR.',
    'ak.msg.returnFailed': 'No se pudo regresar el tanque a Ensamble.',
    'ak.msg.returned': 'Tanque {tank} regresado a Ensamble.',
    'ak.msg.offline': 'No se pudo conectar con el servidor. Revise la conexión e intente de nuevo.',
    'ak.msg.teamSelected': '{team} seleccionado — los empleados escaneados se unen a este equipo.',
    'ak.msg.windingRedirect': 'Esta máquina es de embobinado — redirigiendo…',
    'ak.msg.loadFailed': 'No se pudo cargar el kiosco de Ensamble.',
    'ak.msg.actionFailed': 'La acción no se pudo completar.',
    'ak.msg.selectTankFirst': 'Primero seleccione un tanque para este equipo.',
    'ak.msg.confirmFailed': 'No se pudo confirmar el tanque.',
    'ak.msg.tankConfirmed': 'Tanque confirmado. Presione INICIAR para la mano de obra.',
    'ak.msg.loadEmployeesFailed': 'No se pudieron cargar los empleados.',
    'ak.msg.clockOutQuestion': '¿Registrar la salida de {name}? Solo sale de la mano de obra activa de este equipo.',
    'ak.msg.clockOutFailed': 'No se pudo registrar la salida del empleado.',
    'ak.msg.clockedOut': 'Salida registrada para {name}.',
    'ak.msg.laborStarted': 'Mano de obra de Ensamble iniciada para este equipo.',
    'ak.msg.laborStopped': 'Mano de obra detenida.',
    'ak.msg.finishTitle': '¿Terminar Ensamble?',
    'ak.msg.finishOthers':
      'Esto termina el trabajo de este equipo en {tank}.\n\nEl Ensamble sigue abierto hasta que los otros equipos también terminen: {teams}.',
    'ak.msg.finishLast': 'Esto termina el Ensamble de {tank} y envía el tanque a Listo para Pruebas.',
    'ak.msg.finishLastQa': 'Esto termina el Ensamble de {tank} y envía el tanque a Listo para QA/QC.',
    'ak.msg.finishOk': 'Terminar',
    'ak.msg.removeTitle': '¿Retirar el tanque de Ensamble?',
    'ak.msg.removeBody':
      '{tank}\n\nEsto retira el tanque del programa actual de Ensamble.\nSe conserva el historial de producción ya registrado.',
    'ak.msg.removeOk': 'Retirar de Ensamble',
    'ak.msg.removed': 'Tanque retirado del programa de Ensamble.',
    'ak.msg.lunchOnCard': 'Almuerzo se debe presionar en la tarjeta de un equipo.',
    'ak.msg.lunchStarted': 'Almuerzo del equipo — solo este equipo está en pausa.',
    'ak.msg.resumeOnCard':
      'Reanudar se debe presionar en la tarjeta de un equipo. No vuelva a escanear el código del equipo.',
    'ak.msg.resumed': 'Equipo reanudado.',
    'ak.msg.outOnCard': 'Salida de Empleado se debe presionar en la tarjeta de un equipo.',
    'ak.msg.endShiftOnCard': 'Fin de Turno se debe presionar en la tarjeta de un equipo.',
    'ak.msg.endShiftTitle': '¿Terminar el turno de este equipo?',
    'ak.msg.endShiftBody': 'Detiene la mano de obra de este equipo y quita su tarjeta del kiosco.',
    'ak.msg.endShiftDone': 'Fin de turno del equipo completado.',
    'ak.msg.useButtons':
      'Use los botones para las acciones del tanque. Aquí escanee solo el código de un EQUIPO o EMPLEADO.',
    'ak.msg.scanTeamOrEmployee': 'Escanee solo el código de un Equipo o Empleado.',
    'ak.msg.teamAssigned':
      'Equipo asignado. Seleccione un tanque de la lista y presione CONFIRMAR TANQUE, luego INICIAR para la mano de obra.',
    'ak.msg.selectedEmployee': 'Seleccionado: {name}',
    'ak.msg.employeeSelected': 'Empleado seleccionado.',
    'ak.msg.restoreTitle': '¿Restaurar el tanque a Ensamble?',
    'ak.msg.restoreBody':
      '{tank} se marcó como Terminado y está esperando Pruebas (todavía no inician).\n\n¿Restaurarlo a Ensamble?',
    'ak.msg.restoreOk': 'Restaurar',
    'ak.msg.restored': 'Tanque restaurado a la lista de selección de Ensamble. Confirme el tanque de nuevo.',
    'ak.msg.badResponse': 'Respuesta inválida del servidor.',
  };

  /** Spanish for messages sent by the server (English text, values kept exactly as sent). */
  const SERVER_ES = [
    [/^Please scan a Team barcode first\.$/, () => 'Primero escanee el código de un Equipo.'],
    [
      /^Use the on-screen buttons for tank actions\. Scan only a TEAM or EMPLOYEE barcode\.$/,
      () => 'Use los botones de la pantalla para las acciones del tanque. Escanee solo el código de un EQUIPO o EMPLEADO.',
    ],
    [
      /^Unrecognized barcode\. Scan a Team or employee badge only\.$/,
      () => 'Código no reconocido. Escanee solo el código de un Equipo o el gafete de un empleado.',
    ],
    [/^Barcode required\.$/, () => 'Se requiere un código.'],
    [
      /^Open an assembly machine kiosk URL to use this screen\.$/,
      () => 'Abra la dirección del kiosco de la máquina de Ensamble para usar esta pantalla.',
    ],
    [/^This machine is Winding\. Open the winding kiosk\.$/, () => 'Esta máquina es de embobinado. Abra el kiosco de embobinado.'],
    [
      /^Team labor stopped and team removed from this Assembly kiosk\.$/,
      () => 'Mano de obra del equipo detenida y equipo retirado de este kiosco de Ensamble.',
    ],
    [
      /^Station labor stopped and team assignment cleared\.$/,
      () => 'Mano de obra de la estación detenida y asignación de equipo borrada.',
    ],
    [/^Could not process assembly action\.$/, () => 'No se pudo procesar la acción de Ensamble.'],
    [
      /^QA\/Testing actions are only available on the QA\/QC kiosk\.$/,
      () => 'Las acciones de QA/Pruebas solo están disponibles en el kiosco de QA/QC.',
    ],
    [/^That employee is not currently on shift for this team\.$/, () => 'Ese empleado no está en turno con este equipo.'],
    [/^Could not mark employee out\.$/, () => 'No se pudo registrar la salida del empleado.'],
    [/^Could not load shift employees\.$/, () => 'No se pudieron cargar los empleados del turno.'],
    [
      /^Team assigned\. Select a tank from the dropdown and press CONFIRM TANK, then START for labor\.$/,
      () => ES['ak.msg.teamAssigned'],
    ],
    [/^Team already on this Assembly kiosk\.$/, () => 'El equipo ya está en este kiosco de Ensamble.'],

    [
      /^Tank (.+?) confirmed — Assembly Duration started\. Press START for labor\.(?: Also in Assembly: (.+)\.)?$/,
      (m) =>
        `Tanque ${m[1]} confirmado — inició la Duración de Ensamble. Presione INICIAR para la mano de obra.` +
        (m[2] ? ` También en Ensamble: ${m[2]}.` : ''),
    ],
    [
      /^Tank (.+?) selected — Assembly Duration continues \(not reset\)\.(?: Also in Assembly: (.+)\.)?$/,
      (m) =>
        `Tanque ${m[1]} seleccionado — la Duración de Ensamble continúa (no se reinicia).` +
        (m[2] ? ` También en Ensamble: ${m[2]}.` : ''),
    ],
    [
      /^Scan a Team barcode before confirming a tank\.$/,
      () => 'Escanee el código de un Equipo antes de confirmar un tanque.',
    ],
    [
      /^Tank status "(.+)" cannot be confirmed for Assembly\..*$/,
      (m) => `Un tanque con estado "${m[1]}" no se puede confirmar para Ensamble.`,
    ],
    [/^Tank not found\.$/, () => 'Tanque no encontrado.'],
    [/^Tank is completed\/archived\.$/, () => 'El tanque está completado/archivado.'],
    [/^Tank is already archived\.$/, () => 'El tanque ya está archivado.'],
    [/^Machine not found or inactive\.$/, () => 'Máquina no encontrada o inactiva.'],

    [
      /^Confirm the tank first\. CONFIRM TANK starts Assembly Duration; START WORK starts labor\.$/,
      () => 'Primero confirme el tanque. CONFIRMAR TANQUE inicia la Duración de Ensamble; INICIAR inicia la mano de obra.',
    ],
    [/^Scan a Team barcode before starting work\.$/, () => 'Escanee el código de un Equipo antes de iniciar el trabajo.'],
    [
      /^Tank (.+) is not confirmed for this team\. Select it and press CONFIRM TANK first\.$/,
      (m) => `El tanque ${m[1]} no está confirmado para este equipo. Selecciónelo y presione CONFIRMAR TANQUE primero.`,
    ],
    [
      /^This team already has active Assembly labor on this tank\.$/,
      () => 'Este equipo ya tiene mano de obra de Ensamble activa en este tanque.',
    ],
    [
      /^Tank already has an active stage labor session on this machine\.$/,
      () => 'El tanque ya tiene mano de obra activa en esta máquina.',
    ],
    [/^Tank already has an active stage labor session\.$/, () => 'El tanque ya tiene mano de obra activa.'],
    [
      /^Assign a team to this machine before starting work\.$/,
      () => 'Asigne un equipo a esta máquina antes de iniciar el trabajo.',
    ],
    [/^This tank belongs to another Assembly team\.$/, () => 'Este tanque pertenece a otro equipo de Ensamble.'],
    [
      /^No employees on shift for the assigned team\. Team assign alone does not start labor\.$/,
      () => 'No hay empleados en turno para el equipo asignado. Asignar el equipo no inicia la mano de obra.',
    ],
    [/^Employee\(s\) already in active stage labor: (.+)\.$/, (m) => `Empleado(s) que ya tienen mano de obra activa: ${m[1]}.`],
    [
      /^Employee (.+) already has an active stage labor session\.$/,
      (m) => `El empleado ${m[1]} ya tiene mano de obra activa.`,
    ],
    [
      /^Tank status "(.+)" is not eligible for (\w+)\.( Press CONFIRM TANK first.*)?$/,
      (m) =>
        `El estado del tanque "${m[1]}" no es válido para ${m[2] === 'ASSEMBLY' ? 'Ensamble' : m[2]}.` +
        (m[3]
          ? ' Primero presione CONFIRMAR TANQUE para entrar a Ensamble (inicia la Duración de Ensamble). Luego INICIAR para la mano de obra.'
          : ''),
    ],

    [/^No active stage labor session to stop\.$/, () => 'No hay mano de obra activa para detener.'],
    [/^Session does not belong to this machine\.$/, () => 'La sesión no pertenece a esta máquina.'],

    [
      /^Confirm the tank first \(CONFIRM TANK\), then complete Assembly\.$/,
      () => 'Primero confirme el tanque (CONFIRMAR TANQUE) y luego termine el Ensamble.',
    ],
    [
      /^Cannot complete assembly from status "(.+)"\.$/,
      (m) => `No se puede terminar el Ensamble desde el estado "${m[1]}".`,
    ],
    [
      /^Several teams are working this tank — FINISH from a team card\.$/,
      () => 'Varios equipos trabajan en este tanque — presione TERMINAR en la tarjeta de un equipo.',
    ],
    [
      /^Tank (.+) is not confirmed for this team — nothing to finish\.$/,
      (m) => `El tanque ${m[1]} no está confirmado para este equipo — no hay nada que terminar.`,
    ],
    [
      /^(.+) finished Tank (.+)\. Assembly stays open until all teams finish — still working: (.+)\.$/,
      (m) =>
        `${m[1]} terminó el Tanque ${m[2]}. El Ensamble sigue abierto hasta que todos los equipos terminen — todavía trabajando: ${m[3]}.`,
    ],
    [
      /^(All teams finished\. )?Assembly complete — Ready for Testing\. QA\/QC reviews the tank after Testing\.$/,
      (m) =>
        `${m[1] ? 'Todos los equipos terminaron. ' : ''}Ensamble completo — Listo para Pruebas. QA/QC revisa el tanque después de Pruebas.`,
    ],
    [
      /^(All teams finished\. )?Assembly complete — Ready for QA\/QC \(no testing required\)\.$/,
      (m) => `${m[1] ? 'Todos los equipos terminaron. ' : ''}Ensamble completo — Listo para QA/QC (no requiere pruebas).`,
    ],

    [
      /^Team Lunch — this Team Card only\. Press Resume on the same card when ready\.$/,
      () => 'Almuerzo del equipo — solo esta tarjeta. Presione Reanudar en la misma tarjeta cuando estén listos.',
    ],
    [
      /^Lunch must come from a Team Card \(team_id required\)\.$/,
      () => 'El almuerzo se debe marcar desde la tarjeta de un equipo.',
    ],
    [
      /^Resume must come from a Team Card \(team_id required\)\. Do not rescan the Team barcode\.$/,
      () => 'Reanudar se debe marcar desde la tarjeta de un equipo. No vuelva a escanear el código del equipo.',
    ],
    [
      /^This team is not present on this Assembly kiosk\. Scan the Team barcode once to open its card\.$/,
      () => 'Este equipo no está en este kiosco de Ensamble. Escanee una vez el código del equipo para abrir su tarjeta.',
    ],
    [
      /^Team resumed from Lunch\. No paused Assembly labor was found — press START on this Team Card to begin labor\.$/,
      () =>
        'El equipo regresó del almuerzo. No se encontró mano de obra de Ensamble en pausa — presione INICIAR en esta tarjeta para comenzar.',
    ],
    [
      /^No Assembly work is paused for Lunch for this team\.$/,
      () => 'Este equipo no tiene trabajo de Ensamble en pausa por almuerzo.',
    ],
    [
      /^Team resumed — Assembly labor continues for this Team Card only\.$/,
      () => 'Equipo reanudado — la mano de obra de Ensamble continúa solo para esta tarjeta.',
    ],

    [
      /^Tank restored to the Assembly selection list\. Confirm the tank again\. Prior labor and the original Finish are preserved\.$/,
      () =>
        'Tanque restaurado a la lista de selección de Ensamble. Confirme el tanque de nuevo. Se conservan la mano de obra previa y el Terminado original.',
    ],
    [
      /^Restore from the Assembly kiosk is only allowed before Testing starts\. Use RESTORE TO ASSEMBLY on the Testing \/ QA\/QC kiosk\.$/,
      () =>
        'Restaurar desde el kiosco de Ensamble solo se permite antes de que inicien las Pruebas. Use RESTAURAR A ENSAMBLE en el kiosco de Pruebas / QA/QC.',
    ],
    [/^Tank was finished on another Assembly kiosk\.$/, () => 'El tanque se terminó en otro kiosco de Ensamble.'],

    [
      /^Tank removed from the Assembly schedule\. It is not Ready for QA and was not deleted\. Prior labor is preserved\.$/,
      () =>
        'Tanque retirado del programa de Ensamble. No está Listo para QA y no se eliminó. Se conserva la mano de obra previa.',
    ],
    [
      /^Remove from Assembly only applies to a confirmed Assembly tank \(got "(.+)"\)\.$/,
      (m) => `Retirar de Ensamble solo aplica a un tanque confirmado en Ensamble (estado "${m[1]}").`,
    ],
    [
      /^This tank is not confirmed for this Assembly team\.$/,
      () => 'Este tanque no está confirmado para este equipo de Ensamble.',
    ],
    [/^Tank is confirmed on another Assembly kiosk\.$/, () => 'El tanque está confirmado en otro kiosco de Ensamble.'],

    [
      /^Tank (.+) returned to Assembly\. Select it and press CONFIRM TANK to continue\.$/,
      (m) => `Tanque ${m[1]} regresado a Ensamble. Selecciónelo y presione CONFIRMAR TANQUE para continuar.`,
    ],
    [/^Tank (.+) was already returned to Assembly\.$/, (m) => `El tanque ${m[1]} ya se regresó a Ensamble.`],
    [
      /^Tank (.+) is not Removed from Assembly \(status "(.+)"\)\.$/,
      (m) => `El tanque ${m[1]} no está Retirado de Ensamble (estado "${m[2]}").`,
    ],
    [
      /^Tank is already completed and cannot return to Assembly\.$/,
      () => 'El tanque ya está completado y no puede regresar a Ensamble.',
    ],

    [/^Select an Assembly team card first\.$/, () => 'Primero seleccione la tarjeta de un equipo de Ensamble.'],
    [
      /^The selected team is not on this Assembly kiosk\.$/,
      () => 'El equipo seleccionado no está en este kiosco de Ensamble.',
    ],
    [
      /^(.+) is on shift with (.+), which is not an Assembly team\. Use Employee Out there first\.$/,
      (m) => `${m[1]} está en turno con ${m[2]}, que no es un equipo de Ensamble. Primero use Salida de Empleado ahí.`,
    ],
    [
      /^(.+) is in active (.+) labor\. Use Employee Out there first\.$/,
      (m) => `${m[1]} tiene mano de obra activa (${m[2]}). Primero use Salida de Empleado ahí.`,
    ],
    [/^(.+) moved from (.+) to (.+) for this shift\.$/, (m) => `${m[1]} pasó de ${m[2]} a ${m[3]} durante este turno.`],
    [/^(.+) joined (.+) for this shift\.$/, (m) => `${m[1]} se unió a ${m[2]} durante este turno.`],
    [/^(.+) transferred from (.+) to (.+)\.$/, (m) => `${m[1]} pasó de ${m[2]} a ${m[3]}.`],
    [/^(.+) joined (.+)\.$/, (m) => `${m[1]} se unió a ${m[2]}.`],
    [/^Selected Employee: (.+)\.$/, (m) => `Empleado seleccionado: ${m[1]}.`],
    [/^(.+) is already on (.+)\.$/, (m) => `${m[1]} ya está en ${m[2]}.`],
    [
      /^(.+) marked out for today\. Production continues\. Default team roster unchanged\.$/,
      (m) => `${m[1]} marcado como fuera por hoy. La producción continúa. Su equipo asignado no cambia.`,
    ],
    [/^(.+) is not currently on shift\.$/, (m) => `${m[1]} no está en turno en este momento.`],
    [/^Employee not found\.$/, () => 'Empleado no encontrado.'],
    [/^That employee is inactive\.$/, () => 'Ese empleado está inactivo.'],
    [
      /^Employee is not in an active stage labor session on this machine\.$/,
      () => 'El empleado no tiene mano de obra activa en esta máquina.',
    ],
    [/^Team not found\.$/, () => 'Equipo no encontrado.'],
  ];

  function i18n() {
    return root.FactoryI18n || null;
  }

  function lang() {
    const fi = i18n();
    return fi && typeof fi.getLang === 'function' ? fi.getLang() : 'en';
  }

  function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (_m, k) =>
      vars && vars[k] != null ? String(vars[k]) : ''
    );
  }

  /** Translate an Assembly key, filling {placeholders} with values exactly as given. */
  function tr(key, vars) {
    const dict = lang() === 'es' ? ES : EN;
    const template = dict[key] != null ? dict[key] : EN[key] != null ? EN[key] : key;
    return fill(template, vars);
  }

  /** Spanish for a known server message; unknown messages are shown unchanged. */
  function trServer(message) {
    const text = String(message == null ? '' : message);
    if (!text || lang() !== 'es') return text;
    const trimmed = text.trim();
    for (const [re, build] of SERVER_ES) {
      const m = trimmed.match(re);
      if (m) return build(m);
    }
    return text;
  }

  const fi = i18n();
  if (fi && fi.DICTS) {
    Object.assign(fi.DICTS.en, EN);
    Object.assign(fi.DICTS.es, ES);
  }

  root.AssemblyI18n = { tr, trServer, lang };
})(window);
