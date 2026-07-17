// ============================================================================
// НАСТРОЙКА FIREBASE
// ============================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyBbV0lY1z17Jx_UdtPYQoKgbv_L-TGLlf4",
  authDomain: "mrg37-b1669.firebaseapp.com",
  projectId: "mrg37-b1669",
  storageBucket: "mrg37-b1669.firebasestorage.app",
  messagingSenderId: "461981527800",
  appId: "1:461981527800:web:6dfb93453a11f41783950d"
};

// Коды доступа (простая защита, НЕ полноценная авторизация).
// Администратор видит экспорт/импорт и журнал изменений, сотрудник — нет.
// Смените оба значения на свои перед тем, как передать ссылку коллеге.
export const ADMIN_CODE = "mrg37admin";
export const STAFF_CODE = "mrg37";
