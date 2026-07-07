// ============================================================
// ZEPHYR — lógica principal
// Simulador educativo. Zephyr Token (ZFT) no tiene valor real.
// ============================================================

import { firebaseConfig } from "./firebase-config.js";
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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

  try {
    // nombre de usuario único
    const existing = await getDocs(query(collection(db, "users"), where("usernameLower", "==", username.toLowerCase())));
    if (!existing.empty) {
      $("registerError").textContent = "Ese nombre de usuario ya está en uso.";
      return;
    }

    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      username,
      usernameLower: username.toLowerCase(),
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
    showAuthScreen();
    return;
  }

  showAppShell();

  // Suscripción en tiempo real al documento del usuario (saldo, admin, etc.)
  unsubUserDoc = onSnapshot(doc(db, "users", user.uid), (snap) => {
    if (!snap.exists()) return;
    currentProfile = snap.data();
    renderProfile();
  });

  // Suscripción en tiempo real al historial
  const txQuery = query(
    collection(db, "users", user.uid, "transactions"),
    orderBy("createdAt", "desc"),
    limit(25)
  );
  unsubTx = onSnapshot(txQuery, (snap) => renderLedger(snap.docs.map(d => d.data())));
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

  if (!currentProfile?.isAdmin) { $("adminGrantError").textContent = "No tienes permisos de administrador."; return; }
  if (!username || !amount) { $("adminGrantError").textContent = "Completa usuario y cantidad."; return; }

  try {
    const q = query(collection(db, "users"), where("usernameLower", "==", username.toLowerCase()));
    const results = await getDocs(q);
    if (results.empty) { $("adminGrantError").textContent = "No existe ese usuario."; return; }
    const targetDoc = results.docs[0];
    const targetRef = doc(db, "users", targetDoc.id);

    await runTransaction(db, async (t) => {
      const snap = await t.get(targetRef);
      t.update(targetRef, { balance: (snap.data().balance || 0) + amount });
    });
    await addDoc(collection(db, "users", targetDoc.id, "transactions"), {
      type: "admin_grant", amount, note: `Otorgado por ${currentProfile.username}`, createdAt: serverTimestamp()
    });

    $("adminGrantSuccess").textContent = `Otorgaste ${fmt(amount)} ZFT a ${targetDoc.data().username}.`;
    $("grantUsername").value = "";
    $("grantAmount").value = "";
    loadAdminUsers();
  } catch (err) {
    $("adminGrantError").textContent = "No se pudo otorgar el saldo.";
  }
});

async function loadAdminUsers() {
  if (!currentProfile?.isAdmin) return;
  const snap = await getDocs(collection(db, "users"));
  const rows = snap.docs.map(d => d.data());
  $("adminUserTable").innerHTML = rows.map(u => `
    <div class="user-row">
      <span class="u-name">${u.username}${u.isAdmin ? '<span class="u-admin-badge">admin</span>' : ""}</span>
      <span class="u-balance">${fmt(u.balance)} ZFT</span>
    </div>
  `).join("");
}

$("adminMethodForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("methodName").value.trim();
  if (!name) return;
  defaultMethods.push(name);
  renderPaymentMethods(defaultMethods);
  renderAdminMethodList();
  $("methodName").value = "";
});

function renderAdminMethodList() {
  $("adminMethodList").innerHTML = defaultMethods.map((m, i) => `
    <span class="method-chip">${m} ${i >= 3 ? `<button data-idx="${i}">✕</button>` : ""}</span>
  `).join("");
  $("adminMethodList").querySelectorAll("button[data-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      defaultMethods.splice(parseInt(btn.dataset.idx, 10), 1);
      renderPaymentMethods(defaultMethods);
      renderAdminMethodList();
    });
  });
}
renderAdminMethodList();

// Cargar usuarios del panel admin al entrar a esa vista
document.querySelector('.nav-btn[data-view="admin"]')?.addEventListener("click", loadAdminUsers);
    
