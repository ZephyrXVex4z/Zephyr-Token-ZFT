// ============================================================
// ZEPHYR — lógica principal
// Simulador educativo. Zephyr Token (ZFT) no tiene valor real.
// ============================================================

import { firebaseConfig } from "./firebase-config.js?v=3";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  collection, query, where, getDocs, addDoc, serverTimestamp,
  runTransaction, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// Nota: la comprobación de nombre de usuario único durante el registro se
// hace contra la colección "usernames" (ver firestore.rules), no contra
// "users", porque antes de iniciar sesión el cliente aún no está
// autenticado y no puede leer la colección "users".

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ------------------------------------------------------------
// PANEL DE DIAGNÓSTICO (temporal) — se crea por JS, no toca index.html.
// Muestra en pantalla lo que normalmente solo se ve en la consola del
// navegador, para poder depurar desde el móvil sin herramientas extra.
// ------------------------------------------------------------
const debugPanel = document.createElement("div");
debugPanel.id = "zephyrDebugPanel";
debugPanel.style.cssText = `
  position: fixed; bottom: 0; left: 0; right: 0; max-height: 40vh;
  overflow-y: auto; background: rgba(0,0,0,0.92); color: #7CFFB2;
  font-family: monospace; font-size: 11px; line-height: 1.5;
  padding: 8px 10px; z-index: 99999; border-top: 2px solid #3FBFB0;
  white-space: pre-wrap; word-break: break-word;
`;
const debugHeader = document.createElement("div");
debugHeader.style.cssText = "display:flex; justify-content:space-between; align-items:center; color:#F2A65A; font-weight:bold; margin-bottom:4px;";
debugHeader.innerHTML = `<span>🔧 Diagnóstico Zephyr (toca ✕ para ocultar)</span>`;
const closeDebugBtn = document.createElement("button");
closeDebugBtn.textContent = "✕";
closeDebugBtn.style.cssText = "color:#F2A65A; background:none; border:1px solid #F2A65A; border-radius:4px; padding:2px 8px;";
closeDebugBtn.onclick = () => debugPanel.remove();
debugHeader.appendChild(closeDebugBtn);
const debugLogEl = document.createElement("div");
debugPanel.appendChild(debugHeader);
debugPanel.appendChild(debugLogEl);
document.body.appendChild(debugPanel);

function debugLog(msg, isError = false) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString("es-ES");
  line.textContent = `[${time}] ${msg}`;
  if (isError) line.style.color = "#F17389";
  debugLogEl.appendChild(line);
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

window.addEventListener("error", (e) => {
  debugLog(`ERROR JS: ${e.message} (${e.filename}:${e.lineno})`, true);
});
window.addEventListener("unhandledrejection", (e) => {
  debugLog(`ERROR PROMESA: ${e.reason?.message || e.reason}`, true);
});

debugLog("Script app.js cargado correctamente.");

// ------------------------------------------------------------
// Estado local
// ------------------------------------------------------------
let currentUser = null;   // Firebase auth user
let currentProfile = null; // Firestore doc: { username, balance, isAdmin, ... }
let unsubUserDoc = null;
let unsubTx = null;
let recaptchaOk = { register: false, buy: false, transfer: false };
let selectedPaymentMethod = null;

// ------------------------------------------------------------
// Helpers de UI
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n ?? 0).toLocaleString("es-ES");

function showAuthScreen() {
  $("authScreen").classList.remove("hidden");
  $("appShell").classList.add("hidden");
}
function showAppShell() {
  $("authScreen").classList.add("hidden");
  $("appShell").classList.remove("hidden");
}
function switchView(viewName) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  $(`view-${viewName}`).classList.add("active");
  document.querySelector(`.nav-btn[data-view="${viewName}"]`)?.classList.add("active");
}

// reCAPTCHA global callbacks (referenced by data-callback in index.html)
window.onRecaptchaRegister = () => { recaptchaOk.register = true; $("registerSubmitBtn").disabled = false; };
window.onRecaptchaBuy = () => { recaptchaOk.buy = true; $("confirmBuyBtn").disabled = false; };
window.onRecaptchaTransfer = () => { recaptchaOk.transfer = true; $("confirmTransferBtn").disabled = false; };

// ------------------------------------------------------------
// AUTH: tabs
// ------------------------------------------------------------
$("tabLogin").addEventListener("click", () => {
  $("tabLogin").classList.add("active"); $("tabLogin").setAttribute("aria-selected", "true");
  $("tabRegister").classList.remove("active"); $("tabRegister").setAttribute("aria-selected", "false");
  $("loginForm").classList.remove("hidden");
  $("registerForm").classList.add("hidden");
});
$("tabRegister").addEventListener("click", () => {
  $("tabRegister").classList.add("active"); $("tabRegister").setAttribute("aria-selected", "true");
  $("tabLogin").classList.remove("active"); $("tabLogin").setAttribute("aria-selected", "false");
  $("registerForm").classList.remove("hidden");
  $("loginForm").classList.add("hidden");
});

// ------------------------------------------------------------
// AUTH: registro
// ------------------------------------------------------------
$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("registerError").textContent = "";
  if (!recaptchaOk.register) {
    $("registerError").textContent = "Completa el reCAPTCHA antes de continuar.";
    return;
  }
  const username = $("registerUsername").value.trim();
  const email = $("registerEmail").value.trim();
  const password = $("registerPassword").value;

  const usernameLower = username.toLowerCase();

  try {
    // nombre de usuario único (colección ligera, legible sin autenticar)
    const usernameSnap = await getDoc(doc(db, "usernames", usernameLower));
    if (usernameSnap.exists()) {
      $("registerError").textContent = "Ese nombre de usuario ya está en uso.";
      return;
    }

    const cred = await createUserWithEmailAndPassword(auth, email, password);

    // Reserva el nombre de usuario (si esto falla, seguimos igual: el
    // registro ya se hizo y el usuario puede entrar con su correo).
    try {
      await setDoc(doc(db, "usernames", usernameLower), { uid: cred.user.uid });
    } catch (_) { /* no bloquea el registro */ }

    await setDoc(doc(db, "users", cred.user.uid), {
      username,
      usernameLower,
      email,
      balance: 100, // regalo de bienvenida ficticio
      isAdmin: false,
      createdAt: serverTimestamp()
    });
    await addDoc(collection(db, "users", cred.user.uid, "transactions"), {
      type: "bonus",
      amount: 100,
      note: "Regalo de bienvenida",
      createdAt: serverTimestamp()
    });
    // onAuthStateChanged se encarga del resto
  } catch (err) {
    $("registerError").textContent = traduceErrorFirebase(err);
  }
});

// ------------------------------------------------------------
// AUTH: login
// ------------------------------------------------------------
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    $("loginError").textContent = traduceErrorFirebase(err);
  }
});

$("logoutBtn").addEventListener("click", () => signOut(auth));

function traduceErrorFirebase(err) {
  const code = err?.code || "";
  if (code.includes("email-already-in-use")) return "Ese correo ya tiene una cuenta.";
  if (code.includes("invalid-email")) return "Correo no válido.";
  if (code.includes("weak-password")) return "La contraseña es demasiado corta.";
  if (code.includes("user-not-found") || code.includes("wrong-password") || code.includes("invalid-credential")) return "Correo o contraseña incorrectos.";
  return "Ocurrió un error. Inténtalo de nuevo.";
}

// ------------------------------------------------------------
// AUTH STATE
// ------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
  if (unsubTx) { unsubTx(); unsubTx = null; }

  if (!user) {
    currentProfile = null;
    debugLog("Sin sesión iniciada.");
    showAuthScreen();
    return;
  }

  debugLog(`Sesión iniciada. UID=${user.uid} email=${user.email}`);
  showAppShell();

  // Suscripción en tiempo real al documento del usuario (saldo, admin, etc.)
  unsubUserDoc = onSnapshot(
    doc(db, "users", user.uid),
    (snap) => {
      if (!snap.exists()) {
        debugLog(`El documento users/${user.uid} NO EXISTE en Firestore.`, true);
        return;
      }
      currentProfile = snap.data();
      debugLog(`Documento users/${user.uid} leído OK → balance=${currentProfile.balance}, isAdmin=${currentProfile.isAdmin} (tipo: ${typeof currentProfile.isAdmin})`);
      renderProfile();
    },
    (err) => {
      debugLog(`ERROR leyendo users/${user.uid}: ${err.code} — ${err.message}`, true);
    }
  );

  // Suscripción en tiempo real al historial
  const txQuery = query(
    collection(db, "users", user.uid, "transactions"),
    orderBy("createdAt", "desc"),
    limit(25)
  );
  unsubTx = onSnapshot(
    txQuery,
    (snap) => renderLedger(snap.docs.map(d => d.data())),
    (err) => debugLog(`ERROR leyendo transactions: ${err.code} — ${err.message}`, true)
  );
});

function renderProfile() {
  if (!currentProfile) return;
  $("headerBalance").textContent = `${fmt(currentProfile.balance)} ZFT`;
  $("headerUsername").textContent = currentProfile.username;
  $("balanceNumber").textContent = fmt(currentProfile.balance);

  if (currentProfile.isAdmin) {
    $("navAdmin").classList.remove("hidden");
  } else {
    $("navAdmin").classList.add("hidden");
  }
}

function renderLedger(txs) {
  const list = $("ledgerList");
  if (!txs.length) {
    list.innerHTML = `<p class="empty-state">Aún no tienes movimientos. Compra o recibe Zephyr para ver tu historial aquí.</p>`;
    return;
  }
  list.innerHTML = txs.map(tx => {
    const isIn = tx.amount >= 0;
    const label = {
      bonus: "Regalo de bienvenida",
      buy: `Compra simulada (${tx.method || "método simulado"})`,
      transfer_in: `Recibido de ${tx.from || "alguien"}`,
      transfer_out: `Enviado a ${tx.to || "alguien"}`,
      admin_grant: "Otorgado por administración"
    }[tx.type] || tx.type;
    const when = tx.createdAt?.toDate ? tx.createdAt.toDate().toLocaleString("es-ES") : "…";
    return `
      <div class="ledger-row">
        <span class="ledger-icon ${isIn ? "in" : "out"}">${isIn ? "↓" : "↑"}</span>
        <div class="ledger-main">
          <div class="ledger-title">${label}</div>
          <div class="ledger-meta">${when}</div>
        </div>
        <span class="ledger-amount ${isIn ? "in" : "out"}">${isIn ? "+" : ""}${fmt(tx.amount)} ZFT</span>
      </div>`;
  }).join("");
}

// ------------------------------------------------------------
// NAVEGACIÓN
// ------------------------------------------------------------
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

$("userMenuBtn").addEventListener("click", () => $("userMenu").classList.toggle("open"));
document.addEventListener("click", (e) => {
  if (!e.target.closest("#userMenuBtn") && !e.target.closest("#userMenu")) {
    $("userMenu").classList.remove("open");
  }
});

$("closeDisclaimer").addEventListener("click", () => $("disclaimerBanner").classList.add("hidden"));

// ------------------------------------------------------------
// MODAL: compra simulada
// ------------------------------------------------------------
const defaultMethods = ["Tarjeta simulada", "PayPal simulado", "Transferencia simulada"];

function renderPaymentMethods(methods) {
  const wrap = $("paymentMethodPicker");
  wrap.innerHTML = methods.map(m => `
    <button type="button" class="payment-method-option" data-method="${m}">${m}</button>
  `).join("");
  wrap.querySelectorAll(".payment-method-option").forEach(btn => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".payment-method-option").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedPaymentMethod = btn.dataset.method;
      $("fakeCardFields").classList.toggle("hidden", !btn.dataset.method.toLowerCase().includes("tarjeta"));
      $("fakePaypalFields").classList.toggle("hidden", !btn.dataset.method.toLowerCase().includes("paypal"));
    });
  });
}
renderPaymentMethods(defaultMethods);

$("openBuyModal").addEventListener("click", () => {
  $("buyModalOverlay").classList.remove("hidden");
});
$("openTransferModal").addEventListener("click", () => {
  $("transferModalOverlay").classList.remove("hidden");
});
document.querySelectorAll("[data-close-modal]").forEach(btn => {
  btn.addEventListener("click", () => {
    $("buyModalOverlay").classList.add("hidden");
    $("transferModalOverlay").classList.add("hidden");
  });
});

$("confirmBuyBtn").addEventListener("click", async () => {
  $("buyError").textContent = "";
  if (!recaptchaOk.buy) { $("buyError").textContent = "Completa el reCAPTCHA."; return; }
  if (!selectedPaymentMethod) { $("buyError").textContent = "Elige un método de pago simulado."; return; }
  const amount = parseInt($("buyAmount").value, 10);
  if (!amount || amount <= 0) { $("buyError").textContent = "Cantidad no válida."; return; }

  try {
    await runTransaction(db, async (t) => {
      const userRef = doc(db, "users", currentUser.uid);
      const snap = await t.get(userRef);
      const newBalance = (snap.data().balance || 0) + amount;
      t.update(userRef, { balance: newBalance });
    });
    await addDoc(collection(db, "users", currentUser.uid, "transactions"), {
      type: "buy",
      amount,
      method: selectedPaymentMethod,
      createdAt: serverTimestamp()
    });
    $("buyModalOverlay").classList.add("hidden");
    resetBuyForm();
  } catch (err) {
    $("buyError").textContent = "No se pudo completar la simulación. Inténtalo de nuevo.";
  }
});

function resetBuyForm() {
  $("buyAmount").value = 100;
  selectedPaymentMethod = null;
  document.querySelectorAll(".payment-method-option").forEach(b => b.classList.remove("selected"));
  $("fakeCardFields").classList.add("hidden");
  $("fakePaypalFields").classList.add("hidden");
}

// ------------------------------------------------------------
// MODAL: transferencia entre usuarios
// ------------------------------------------------------------
$("confirmTransferBtn").addEventListener("click", async () => {
  $("transferError").textContent = "";
  $("transferSuccess").textContent = "";
  if (!recaptchaOk.transfer) { $("transferError").textContent = "Completa el reCAPTCHA."; return; }

  const targetUsername = $("transferUsername").value.trim();
  const amount = parseInt($("transferAmount").value, 10);

  if (!targetUsername) { $("transferError").textContent = "Escribe un usuario destinatario."; return; }
  if (!amount || amount <= 0) { $("transferError").textContent = "Cantidad no válida."; return; }
  if (targetUsername.toLowerCase() === currentProfile.username.toLowerCase()) {
    $("transferError").textContent = "No puedes transferirte a ti mismo.";
    return;
  }

  try {
    const q = query(collection(db, "users"), where("usernameLower", "==", targetUsername.toLowerCase()));
    const results = await getDocs(q);
    if (results.empty) { $("transferError").textContent = "No existe ese usuario."; return; }
    const targetDoc = results.docs[0];
    const targetRef = doc(db, "users", targetDoc.id);
    const senderRef = doc(db, "users", currentUser.uid);

    await runTransaction(db, async (t) => {
      const senderSnap = await t.get(senderRef);
      const targetSnap = await t.get(targetRef);
      const senderBalance = senderSnap.data().balance || 0;
      if (senderBalance < amount) throw new Error("saldo-insuficiente");
      t.update(senderRef, { balance: senderBalance - amount });
      t.update(targetRef, { balance: (targetSnap.data().balance || 0) + amount });
    });

    await addDoc(collection(db, "users", currentUser.uid, "transactions"), {
      type: "transfer_out", amount: -amount, to: targetDoc.data().username, createdAt: serverTimestamp()
    });
    await addDoc(collection(db, "users", targetDoc.id, "transactions"), {
      type: "transfer_in", amount: amount, from: currentProfile.username, createdAt: serverTimestamp()
    });

    $("transferSuccess").textContent = `Enviaste ${fmt(amount)} ZFT a ${targetDoc.data().username}.`;
    $("transferUsername").value = "";
    $("transferAmount").value = "";
  } catch (err) {
    if (err.message === "saldo-insuficiente") {
      $("transferError").textContent = "No tienes saldo suficiente.";
    } else {
      $("transferError").textContent = "No se pudo completar la transferencia.";
    }
  }
});

// ------------------------------------------------------------
// MERCADO REAL (referencia informativa — CoinGecko, API pública)
// ------------------------------------------------------------
async function loadMarketPrices() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true");
    const data = await res.json();
    renderTicker(data);
    renderMarketCards("marketCardsDashboard", data);
    renderMarketCards("marketCardsFull", data);
  } catch (err) {
    $("tickerRow").innerHTML = `<span class="ticker-item muted">No se pudieron cargar los precios en este momento.</span>`;
  }
}

function renderTicker(data) {
  const rows = [
    ["BTC", data.bitcoin],
    ["ETH", data.ethereum]
  ];
  $("tickerRow").innerHTML = rows.map(([sym, d]) => {
    if (!d) return "";
    const chg = d.usd_24h_change || 0;
    const cls = chg >= 0 ? "chg-up" : "chg-down";
    return `<span class="ticker-item"><span class="sym">${sym}</span>$${fmt(Math.round(d.usd))} <span class="${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span></span>`;
  }).join("");
}

function renderMarketCards(containerId, data) {
  const rows = [
    ["Bitcoin", "BTC", data.bitcoin],
    ["Ethereum", "ETH", data.ethereum]
  ];
  $(containerId).innerHTML = rows.map(([name, sym, d]) => {
    if (!d) return "";
    const chg = d.usd_24h_change || 0;
    const cls = chg >= 0 ? "up" : "down";
    return `
      <div class="market-card">
        <span class="mc-sym">${name} (${sym})</span>
        <div class="mc-price">$${fmt(Math.round(d.usd))}</div>
        <span class="mc-chg ${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% (24h)</span>
      </div>`;
  }).join("");
}

loadMarketPrices();
setInterval(loadMarketPrices, 45000);

// ------------------------------------------------------------
// PANEL ADMIN
// ------------------------------------------------------------
$("adminGrantForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("adminGrantError").textContent = "";
  $("adminGrantSuccess").textContent = "";
  const username = $("grantUsername").value.trim();
  const amount = parseInt($("grantAmount").value, 10);

  if (!currentProfile?.isAdmin) { $("adminGrantError").textConten
