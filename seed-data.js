// Исходные данные реестра — загружаются в Firestore один раз, если база пуста.
// Дальше все правки живут в Firestore, этот файл не редактируется приложением.

export const SEED_GROUPS = [
  {
    id: 'A', title: 'Группа А. Готово / на стадии подачи',
    cases: [
      { num:1, name:'Рыков Сергей Николаевич', account:'100021470', status:'Направлен в суд — заседание 30.07.2026, 10:00', badge:'done', icon:'✅', fee:'оплачена', feeBadge:'done' },
      { num:2, name:'Муравьёв Андрей Юрьевич', account:'100004288', status:'Реестр получен, подача приостановлена — ждём оригинал выписки с л/с', badge:'wait', icon:'⏸', fee:'оплачена', feeBadge:'done' },
      { num:3, name:'Самарцева Екатерина Ивановна', account:'090011317', status:'Направлен в суд — 15.07.2026', badge:'done', icon:'✅', fee:'оплачена', feeBadge:'done' },
      { num:4, name:'Омаров Рустам Алик Оглы', account:'090007807', status:'Направлен в суд — 15.07.2026', badge:'done', icon:'✅', fee:'оплачена', feeBadge:'done' },
      { num:5, name:'Зеленцова Надежда Александровна', account:'090024016', status:'Направлен в суд — 15.07.2026', badge:'done', icon:'✅', fee:'оплачена', feeBadge:'done' },
      { num:6, name:'Девочкина Анна Александровна', account:'050002779', status:'Направлен в суд', badge:'done', icon:'✅', fee:'оплачена', feeBadge:'done' },
      { num:7, name:'Жуков Михаил Германович', account:'100011188', status:'Направлен в суд — 16.07.2026', badge:'done', icon:'✅', fee:'оплачена', feeBadge:'done' },
      { num:8, name:'Музанков Василий Николаевич', account:'110062695', status:'Отправлен сторонам — 17.07.2026, ждём реестр', badge:'progress', icon:'📮', fee:'нет заявки', feeBadge:'none' },
    ]
  },
  {
    id: 'B', title: 'Группа Б. Ждём документ (акт/уведомление)',
    cases: [
      { num:9, name:'Сивенков Андрей Евгеньевич', account:'010504941', status:'Черновик почти готов — остался один пункт: период долга', badge:'wait', icon:'🟡', fee:'нет заявки', feeBadge:'none' },
      { num:10, name:'Шуркина Лидия Леонидовна', account:'130000154', status:'Акт получен, но уведомление на чужой л/с — проблема НЕ решена', badge:'problem', icon:'🔴', fee:'нет заявки', feeBadge:'none' },
    ]
  },
  {
    id: 'V', title: 'Группа В. Приостановлено / риски',
    cases: [
      { num:11, name:'Колегова Светлана Александровна', account:'080020736', status:'Отложена — задолженность не просужена', badge:'problem', icon:'🚫', fee:'нет заявки', feeBadge:'none' },
    ]
  },
  {
    id: 'G', title: 'Группа Г. Не требуется',
    cases: [
      { num:12, name:'Соколов Роман Сергеевич', account:'010016290', status:'Отключён', badge:'none', icon:'⚪', fee:'нет заявки', feeBadge:'none' },
      { num:13, name:'Говасари Яна Яшаевна', account:'010015694', status:'Отключена', badge:'none', icon:'⚪', fee:'нет заявки', feeBadge:'none' },
      { num:14, name:'Бученкова Юлия Сергеевна', account:'100007765', status:'Оплачено', badge:'none', icon:'⚪', fee:'нет заявки', feeBadge:'none' },
      { num:15, name:'Халимулин Константин Саитович', account:'020005837', status:'Отключён', badge:'none', icon:'⚪', fee:'нет заявки', feeBadge:'none' },
      { num:16, name:'Румянцев Вадим Сергеевич', account:'100005712', status:'Отключён 01.07.2026', badge:'none', icon:'⚪', fee:'нет заявки', feeBadge:'none' },
      { num:17, name:'Николаева Кристина Степановна', account:'130000135', status:'Отключена 08.07.2026', badge:'none', icon:'⚪', fee:'нет заявки', feeBadge:'none' },
      { num:18, name:'Захарова Марина Ивановна', account:'130001042', status:'Отключена 08.07.2026', badge:'none', icon:'⚪', fee:'нет заявки', feeBadge:'none' },
    ]
  }
];

export const SEED_COURT_CASES = [
  { name:'Рыков Сергей Николаевич', account:'100021470', court:'Кинешемский горсуд', caseNumber:'2-1576/2026', filedDate:'2026-07-08', hearingDate:'2026-07-30T10:00', hearingRoom:'зал №10', dot:'blue', notes:'Материал М-1302/2026, УИД 37RS0007-01-2026-002569-83. Принят к производству 10.07.2026.' },
  { name:'Девочкина Анна Александровна', account:'050002779', court:'Фурмановский горсуд', caseNumber:'', filedDate:'2026-07-02', hearingDate:'', hearingRoom:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Самарцева Екатерина Ивановна', account:'090011317', court:'Вичугский горсуд', caseNumber:'', filedDate:'2026-07-15', hearingDate:'', hearingRoom:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Омаров Рустам Алик Оглы', account:'090007807', court:'Вичугский горсуд', caseNumber:'', filedDate:'2026-07-15', hearingDate:'', hearingRoom:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Зеленцова Надежда Александровна', account:'090024016', court:'Вичугский горсуд', caseNumber:'', filedDate:'2026-07-15', hearingDate:'', hearingRoom:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Жуков Михаил Германович', account:'100011188', court:'Кинешемский горсуд', caseNumber:'', filedDate:'2026-07-16', hearingDate:'', hearingRoom:'', dot:'blue', notes:'Движение неизвестно.' },
];

export const SEED_LOG = [
  { date:'2026-07-17', text:'Музанков — иск отправлен сторонам, ждём реестр.' },
  { date:'2026-07-16', text:'Жуков — иск направлен в суд (Кинешемский горсуд).' },
  { date:'2026-07-15', text:'Самарцева, Омаров, Зеленцова — иски направлены в суд (Вичугский горсуд).' },
  { date:'2026-07-13', text:'Рыков — назначено судебное заседание на 30.07.2026, 10:00.' },
  { date:'2026-07-08', text:'Госпошлина оплачена по 5 делам (Муравьёв, Самарцева, Омаров, Зеленцова, Жуков).' },
];
