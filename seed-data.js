// Исходные данные реестра — загружаются в Firestore один раз, если база пуста.
// Дальше все правки живут в Firestore, этот файл не редактируется приложением.
//
// statusKey — один из фиксированных статусов (см. STATUS_DEFS в app.js).
// feeKey    — 'paid' | 'unpaid'.
// protected — true у базовых 18 дел: их нельзя удалить из интерфейса.

export const SEED_CASES = [
  { num:1,  name:'Рыков Сергей Николаевич',        account:'100021470', address:'', statusKey:'sent_court',   note:'Заседание 30.07.2026, 10:00',                          feeKey:'paid',   protected:true },
  { num:2,  name:'Муравьёв Андрей Юрьевич',        account:'100004288', address:'', statusKey:'waiting_doc',  note:'Реестр получен, ждём оригинал выписки с л/с',          feeKey:'paid',   protected:true },
  { num:3,  name:'Самарцева Екатерина Ивановна',   account:'090011317', address:'', statusKey:'sent_court',   note:'15.07.2026',                                            feeKey:'paid',   protected:true },
  { num:4,  name:'Омаров Рустам Алик Оглы',        account:'090007807', address:'', statusKey:'sent_court',   note:'15.07.2026',                                            feeKey:'paid',   protected:true },
  { num:5,  name:'Зеленцова Надежда Александровна',account:'090024016', address:'', statusKey:'sent_court',   note:'15.07.2026',                                            feeKey:'paid',   protected:true },
  { num:6,  name:'Девочкина Анна Александровна',   account:'050002779', address:'', statusKey:'sent_court',   note:'',                                                      feeKey:'paid',   protected:true },
  { num:7,  name:'Жуков Михаил Германович',        account:'100011188', address:'', statusKey:'sent_court',   note:'16.07.2026',                                            feeKey:'paid',   protected:true },
  { num:8,  name:'Музанков Василий Николаевич',    account:'110062695', address:'', statusKey:'sent_debtor',  note:'17.07.2026, ждём реестр',                               feeKey:'unpaid', protected:true },
  { num:9,  name:'Сивенков Андрей Евгеньевич',     account:'010504941', address:'', statusKey:'draft',        note:'Остался один пункт: период долга',                     feeKey:'unpaid', protected:true },
  { num:10, name:'Шуркина Лидия Леонидовна',       account:'130000154', address:'', statusKey:'problem',      note:'Акт получен, но уведомление на чужой л/с',              feeKey:'unpaid', protected:true },
  { num:11, name:'Колегова Светлана Александровна',account:'080020736', address:'', statusKey:'postponed',    note:'Задолженность не просужена',                            feeKey:'unpaid', protected:true },
  { num:12, name:'Соколов Роман Сергеевич',        account:'010016290', address:'', statusKey:'disconnected', note:'',                                                      feeKey:'unpaid', protected:true },
  { num:13, name:'Говасари Яна Яшаевна',           account:'010015694', address:'', statusKey:'disconnected', note:'',                                                      feeKey:'unpaid', protected:true },
  { num:14, name:'Бученкова Юлия Сергеевна',       account:'100007765', address:'', statusKey:'paid',         note:'',                                                      feeKey:'unpaid', protected:true },
  { num:15, name:'Халимулин Константин Саитович',  account:'020005837', address:'', statusKey:'disconnected', note:'',                                                      feeKey:'unpaid', protected:true },
  { num:16, name:'Румянцев Вадим Сергеевич',       account:'100005712', address:'', statusKey:'disconnected', note:'01.07.2026',                                            feeKey:'unpaid', protected:true },
  { num:17, name:'Николаева Кристина Степановна',  account:'130000135', address:'', statusKey:'disconnected', note:'08.07.2026',                                            feeKey:'unpaid', protected:true },
  { num:18, name:'Захарова Марина Ивановна',       account:'130001042', address:'', statusKey:'disconnected', note:'08.07.2026',                                            feeKey:'unpaid', protected:true },
];

export const SEED_COURT_CASES = [
  { name:'Рыков Сергей Николаевич', account:'100021470', court:'Кинешемский горсуд', caseNumber:'2-1576/2026', filedDate:'2026-07-08',
    hearings:[{ date:'2026-07-30T10:00', note:'' }], judge:'', dot:'blue',
    notes:'Материал М-1302/2026, УИД 37RS0007-01-2026-002569-83. Принят к производству 10.07.2026. (Зал: №10)' },
  { name:'Девочкина Анна Александровна', account:'050002779', court:'Фурмановский горсуд', caseNumber:'', filedDate:'2026-07-02',
    hearings:[], judge:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Самарцева Екатерина Ивановна', account:'090011317', court:'Вичугский горсуд', caseNumber:'', filedDate:'2026-07-15',
    hearings:[], judge:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Омаров Рустам Алик Оглы', account:'090007807', court:'Вичугский горсуд', caseNumber:'', filedDate:'2026-07-15',
    hearings:[], judge:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Зеленцова Надежда Александровна', account:'090024016', court:'Вичугский горсуд', caseNumber:'', filedDate:'2026-07-15',
    hearings:[], judge:'', dot:'blue', notes:'Движение неизвестно.' },
  { name:'Жуков Михаил Германович', account:'100011188', court:'Кинешемский горсуд', caseNumber:'', filedDate:'2026-07-16',
    hearings:[], judge:'', dot:'blue', notes:'Движение неизвестно.' },
];

export const SEED_LOG = [
  { date:'2026-07-17', text:'Музанков — иск отправлен сторонам, ждём реестр.' },
  { date:'2026-07-16', text:'Жуков — иск направлен в суд (Кинешемский горсуд).' },
  { date:'2026-07-15', text:'Самарцева, Омаров, Зеленцова — иски направлены в суд (Вичугский горсуд).' },
  { date:'2026-07-13', text:'Рыков — назначено судебное заседание на 30.07.2026, 10:00.' },
  { date:'2026-07-08', text:'Госпошлина оплачена по 5 делам (Муравьёв, Самарцева, Омаров, Зеленцова, Жуков).' },
];
