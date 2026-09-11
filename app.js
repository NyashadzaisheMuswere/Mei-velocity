const RATE=0.75;
async function geocode(place){
  const q=place.toLowerCase().includes("harare")?place:place+", Harare, Zimbabwe";
  const r=await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q="+encodeURIComponent(q));
  const d=await r.json();if(!d.length)throw new Error("Location not found: "+place);
  return {lat:+d[0].lat,lon:+d[0].lon};
}
async function calculateFare(){
  const a=document.getElementById("pickup").value.trim(),b=document.getElementById("dropoff").value.trim();
  if(!a||!b){document.getElementById("status").textContent="Enter both locations.";return}
  document.getElementById("status").textContent="Calculating route...";
  try{
    const p=await geocode(a),q=await geocode(b);
    const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${p.lon},${p.lat};${q.lon},${q.lat}?overview=false`);
    const d=await r.json();if(d.code!=="Ok")throw new Error("Route unavailable.");
    const km=d.routes[0].distance/1000,fare=km*RATE;
    document.getElementById("distance").textContent=km.toFixed(1)+" km";
    document.getElementById("total").textContent="$"+fare.toFixed(2);
    document.getElementById("status").textContent="Fare calculated at $0.75 per kilometre.";
    window.rideFare={km,fare};
  }catch(e){document.getElementById("status").textContent=e.message}
}
document.getElementById("fareBtn").onclick=calculateFare;
document.getElementById("bookBtn").onclick=()=>{
  if(!window.rideFare){calculateFare();return}
  const method=document.querySelector('input[name="payment"]:checked').value,s=document.getElementById("success");
  s.style.display="block";s.textContent=`Ride request: ${window.rideFare.km.toFixed(1)} km — $${window.rideFare.fare.toFixed(2)} — ${method}.`;
};
function preview(input,img){const f=input.files?.[0];if(!f)return;const r=new FileReader();r.onload=e=>img.src=e.target.result;r.readAsDataURL(f)}
function previewService(i){preview(i,i.parentElement.querySelector("img"));i.parentElement.querySelector("span").textContent="Picture selected"}
function previewFleet(i){preview(i,i.parentElement.querySelector("img"));i.parentElement.querySelector("span").textContent="Picture selected"}
function previewVehicle(i){preview(i,i.parentElement.querySelector("img"));i.parentElement.querySelector("span").textContent="Picture selected"}
function previewLogo(i){preview(i,i.parentElement.querySelector("img"))}