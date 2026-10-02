(() => {
  const API = ["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://localhost:5000"
    : "https://mei-velocity1.onrender.com";
  const bookingId = new URLSearchParams(location.search).get("bookingId");
  const conversation = document.getElementById("conversation");
  const status = document.getElementById("chatStatus");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const sendButton = form.querySelector("button");
  let signature = "";
  let loading = false;

  let session = null;
  try { session = JSON.parse(localStorage.getItem("meiVelocityCustomerSession") || "null"); } catch { }
  document.getElementById("backToRide").href = bookingId
    ? `index.html?view=ride&bookingId=${encodeURIComponent(bookingId)}`
    : "index.html";

  function showMessages(messages) {
    const nextSignature = messages.map(message => message.id).join(",");
    if (nextSignature === signature) return;
    signature = nextSignature;
    conversation.replaceChildren();
    for (const message of messages) {
      const item = document.createElement("article");
      item.className = "chat-message" + (message.senderType === "customer" ? " mine" : "");
      const author = document.createElement("small");
      const time = new Date(message.createdAt);
      author.textContent = `${message.senderType === "customer" ? "You" : message.senderName} · ${Number.isNaN(time.getTime()) ? "" : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const text = document.createElement("div");
      text.textContent = message.body;
      item.append(author, text);
      conversation.append(item);
    }
    conversation.scrollTop = conversation.scrollHeight;
  }

  async function refresh() {
    if (loading || !bookingId || !session?.token) return;
    loading = true;
    try {
      const response = await fetch(`${API}/api/customer/bookings/${encodeURIComponent(bookingId)}/messages`, {
        headers: { Authorization: `Bearer ${session.token}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not open this ride chat.");
      showMessages(data.messages || []);
      const latestDriverMessage = (data.messages || []).slice().reverse().find(message => message.senderType === "driver");
      if (latestDriverMessage) localStorage.setItem(`meiVelocityChatRead:${bookingId}`, String(latestDriverMessage.id));
      status.textContent = "Messages refresh automatically.";
      form.hidden = false;
    } catch (error) {
      status.textContent = error.message;
      form.hidden = true;
    } finally { loading = false; }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body || !bookingId || !session?.token || sendButton.disabled) return;
    sendButton.disabled = true;
    status.textContent = "Sending…";
    try {
      const response = await fetch(`${API}/api/customer/bookings/${encodeURIComponent(bookingId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ body })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to send your message.");
      input.value = "";
      signature = "";
      status.textContent = "Sent. Waiting for your driver’s reply…";
      await refresh();
    } catch (error) { status.textContent = error.message; }
    finally { sendButton.disabled = false; }
  });

  if (!bookingId) {
    form.hidden = true;
    status.textContent = "This chat link is missing its ride number. Return to your ride and open Message driver again.";
  } else if (!session?.token) {
    form.hidden = true;
    status.textContent = "Your customer sign-in has expired. Sign in again from the MEI Velocity home page.";
  } else {
    refresh();
    window.setInterval(refresh, 3500);
  }
})();
