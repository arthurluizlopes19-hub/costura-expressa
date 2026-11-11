// Não deixa o app abrir dentro de iframe de outro site (proteção contra clickjacking).
if(window.top!==window.self){ try{ window.top.location.replace(window.self.location.href); }catch(e){ document.documentElement.innerHTML=""; } }
(function(){
const ARTIFACT_URL = location.href.split("#")[0];
const $ = s => document.querySelector(s);
const BRL = new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});
const money = v => BRL.format(Number(v)||0);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const STATUS = {recebido:"Recebido", em_costura:"Em costura", pronto:"Pronto", entregue:"Entregue"};
const ls = {get(k,d){try{const v=localStorage.getItem(k);return v==null?d:v}catch(e){return d}}, set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};

let db = null;
let services = [];
let orders = [];
let cart = {};           // serviceId -> qty
let photos = [];         // {blob,url}
let audio = null;        // {blob,url,type}
let filter = "ativos";
let openCode = null;
let saving = false;
let sheetKey = -1;
let takePhoto = null; // {blob,url}
const ROLES = {gerencia:"Gerência", admin:"Administração", atendente:"Atendente", costureira:"Costureira"};
const VIEWS = {gerencia:["atendimento","pedidos","clientes","dodia","caixa","faturamento","despesas","producao","entregues","servicos","equipe"], admin:["atendimento","pedidos","clientes","dodia","caixa","producao","entregues","servicos","equipe"], atendente:["atendimento","pedidos","clientes","dodia","caixa","entregues"], costureira:["costureiras","logistica","entregues"]};
let team = [];
let teamLoaded = false;
let session = null;      // {id,nome,papel}
let isOwner = false;
let loginPick = null;    // membro escolhido na tela de login
let loginErr = "";
let pendingMemDel = null;
let pinEdit = null;

/* ---------- utilidades ---------- */
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,3200); }
function newCode(){ const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s=""; const r=crypto.getRandomValues(new Uint8Array(6)); r.forEach(n=>s+=a[n%a.length]); return "CE-"+s; }
function fmtDate(ts){ const d=new Date(ts); return d.toLocaleDateString("pt-BR")+" "+d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); }
function fmtDay(iso){ if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; }
function writeErr(e){
  console.error(e);
  if(e && (e.code==="permission-denied"||e.code==="invalid_argument")) toast("Sem permissão para gravar. Confira as regras do Firestore.");
  else if(e && (e.code==="resource-exhausted"||e.code==="quota_exceeded")) toast("Limite do banco atingido. Tente mais tarde ou apague pedidos antigos.");
  else if(e && /INTERNAL ASSERTION|internal/i.test(String(e.code||"")+" "+String(e.message||""))) toast("O app travou a gravação. Feche o app por completo e abra de novo.");
  else if(e && (e.code==="unauthenticated")) toast("Este aparelho saiu do ateliê. Feche e abra o app e entre de novo.");
  else if(e && e.code && /unavailable|deadline/.test(e.code)) toast("Sem conexão com o banco. Verifique a internet e tente de novo.");
  else toast("Não foi possível salvar"+(e&&(e.code||e.message)?" ("+String(e.code||e.message).slice(0,60)+")":"")+". Tente de novo.");
}

/* ---------- arquivos (fotos/áudio) guardados em partes no banco ---------- */
const CHUNK = 190000;
function blobToB64(blob){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result).split(",")[1]||""); r.onerror=rej; r.readAsDataURL(blob); }); }
async function saveBlob(blob, kind){
  const id = "a"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  const b64 = await blobToB64(blob);
  const n = Math.max(1, Math.ceil(b64.length/CHUNK));
  for(let i=0;i<n;i++){ await db.doc(`arquivos/${id}/partes/p${i}`).set({i, d:b64.slice(i*CHUNK,(i+1)*CHUNK)}); }
  await db.doc(`arquivos/${id}`).set({tipo: blob.type||"", n, kind, tamanho: blob.size, criadoEm: Date.now()});
  return id;
}
// Só tipos de imagem e áudio conhecidos viram arquivo para o navegador; qualquer outro vira binário inerte (nada de HTML/SVG/script).
const TIPOS_IMG=["image/jpeg","image/png","image/webp"];
const TIPOS_AUDIO=/^(audio\/(mpeg|mp4|x-m4a|m4a|aac|ogg|webm|wav|x-wav|amr|3gpp|3gpp2|opus|flac)|video\/(mp4|3gpp|webm))$/;
function tipoSeguro(t,kind){ t=String(t||"").toLowerCase().split(";")[0].trim();
  if(kind!=="audio" && TIPOS_IMG.includes(t)) return t;
  if(kind!=="foto" && TIPOS_AUDIO.test(t)) return t;
  return "application/octet-stream"; }
// Confere a assinatura (primeiros bytes) do arquivo de áudio, sem confiar só na extensão ou no tipo informado.
async function audioValido(f){
  try{ const b=new Uint8Array(await f.slice(0,16).arrayBuffer()); const asc=(i,n)=>String.fromCharCode(...b.slice(i,i+n));
    return asc(4,4)==="ftyp" || asc(0,4)==="OggS" || asc(0,3)==="ID3" || (b[0]===0xFF && (b[1]&0xE0)===0xE0) || asc(0,4)==="RIFF" && asc(8,4)==="WAVE"
      || (b[0]===0x1A && b[1]===0x45 && b[2]===0xDF && b[3]===0xA3) || asc(0,5)==="#!AMR" || asc(0,4)==="fLaC";
  }catch(e){ return false; } }
const blobCache = new Map();
function loadBlob(id){
  if(blobCache.has(id)) return blobCache.get(id);
  const p = (async()=>{
    const meta = await db.doc(`arquivos/${id}`).get();
    if(!meta.exists) throw new Error("arquivo não encontrado");
    const m = meta.data();
    const snap = await db.collection(`arquivos/${id}/partes`).orderBy("i").get();
    const b64 = snap.docs.map(d=>d.data().d).join("");
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([u],{type:tipoSeguro(m.tipo, m.kind)}));
  })();
  blobCache.set(id,p); p.catch(()=>blobCache.delete(id));
  return p;
}
function compressImage(file, max=1400, q=.72){
  return new Promise((res,rej)=>{
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload=()=>{ let {width:w,height:h}=img; const s=Math.min(1,max/Math.max(w,h)); w=Math.round(w*s); h=Math.round(h*s);
      const c=document.createElement("canvas"); c.width=w; c.height=h; c.getContext("2d").drawImage(img,0,0,w,h);
      c.toBlob(b=>{URL.revokeObjectURL(url); b?res(b):rej(new Error("falha"))},"image/jpeg",q); };
    img.onerror=()=>{URL.revokeObjectURL(url); rej(new Error("imagem inválida"))};
    img.src=url;
  });
}

/* ---------- abas ---------- */
const ALL_VIEWS=["menu","atendimento","pedidos","clientes","despesas","dodia","caixa","faturamento","costureiras","producao","logistica","entregues","servicos","equipe"];
const IC=(d)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const VIEW_INFO={
  atendimento:{t:"Atendimento", d:"Fazer um novo pedido", i:IC('<path d="M12 5v14M5 12h14"/>')},
  pedidos:{t:"Pedidos", d:"Encontrar e pesquisar pedidos", i:IC('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')},
  clientes:{t:"Clientes", d:"Todas as clientes cadastradas", i:IC('<circle cx="12" cy="7" r="4"/><path d="M5 21v-1a7 7 0 0 1 14 0v1"/><path d="M3 3h4M17 3h4"/>')},
  dodia:{t:"Entregar no dia", d:"O que sai hoje", i:IC('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>')},
  caixa:{t:"Caixa do dia", d:"Quanto entrou hoje", i:IC('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>')},
  despesas:{t:"Despesas", d:"Gastos do ateliê e lucro do mês", i:IC('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>')},
  faturamento:{t:"Faturamento", d:"Quanto entrou no mês", i:IC('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>')},
  costureiras:{t:"Fila de costura", d:"Pegar e terminar pedidos", i:IC('<path d="M6 3v6a6 6 0 0 0 12 0V3"/><path d="M4 21h16"/>')},
  producao:{t:"Costureiras", d:"Quem está fazendo o quê", i:IC('<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M17 4a3.5 3.5 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3"/>')},
  logistica:{t:"Logística", d:"Prazos e locais das peças", i:IC('<path d="M3 7h11v10H3zM14 10h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>')},
  entregues:{t:"Entregues", d:"Histórico de pedidos entregues", i:IC('<path d="M20 6 9 17l-5-5"/>')},
  servicos:{t:"Serviços", d:"Tabela de serviços e preços", i:IC('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>')},
  equipe:{t:"Equipe", d:"Acessos e senhas", i:IC('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>')}
};
let curView="menu";
function menuBadges(){
  const hoje=isoDay(new Date()); const b={};
  const ab=orders.filter(o=>o.status!=="entregue");
  b.dodia=[ab.filter(o=>o.entrega===hoje).length, ab.some(o=>o.entrega && o.entrega<hoje)];
  b.costureiras=[orders.filter(o=>o.status==="recebido").length,false];
  b.producao=[orders.filter(o=>o.status==="em_costura").length,false];
  b.clientes=[listaClientes().length,false];
  return b;
}
function renderMenu(){
  const g=$("#menu-grid"); if(!g || !session) return;
  $("#menu-hello").textContent=`Olá, ${cap(String(session.nome||"").toLocaleLowerCase("pt-BR").split(" ")[0])}!`;
  const bd=menuBadges();
  g.innerHTML=VIEWS[session.papel].map(v=>{ const f=VIEW_INFO[v]; if(!f) return ""; const x=bd[v];
    return `<button class="mtile${v==="atendimento"||(v==="costureiras"&&session.papel==="costureira")?" main":""}" data-go="${v}"><span class="ic">${f.i}</span><span class="tx"><b>${f.t}</b><small>${f.d}</small></span>${x&&(x[0]||x[1])?`<span class="badge${x[1]?" warn":""}">${x[0]}${x[1]?"!":""}</span>`:"<span></span>"}<span class="chev" aria-hidden="true">›</span></button>`; }).join("");
}
$("#menu-grid").addEventListener("click",e=>{ const b=e.target.closest("[data-go]"); if(b) setView(b.dataset.go); });
function setView(v,fromHistory){
  const allowed = session ? ["menu",...VIEWS[session.papel]] : [];
  if(!allowed.includes(v)) v = "menu";
  ALL_VIEWS.forEach(x=>{ const el=$("#view-"+x); if(el) el.hidden = x!==v; });
  $("#totalbar").hidden = v!=="atendimento";
  $("#pagebar").hidden = v==="menu";
  $("#page-title").textContent = v==="menu" ? "" : (VIEW_INFO[v]||{}).t||"";
  if(v==="menu") renderMenu();
  if(!fromHistory && v!=="menu" && curView==="menu"){ try{ history.pushState({ce:v},""); }catch(e){} }
  curView=v; window.scrollTo(0,0);
}
$("#go-menu").addEventListener("click",()=>{ if(history.state&&history.state.ce){ history.back(); } else setView("menu"); });
window.addEventListener("popstate",()=>{
  if(!$("#scanner").hidden){ closeScanner(); return; }
  if(!$("#imgview").hidden){ $("#imgview").hidden=true; return; }
  if(!$("#overlay").hidden){ closeSheet(); return; }
  if(session && curView!=="menu") setView("menu",true);
});

/* ---------- atendimento: serviços ---------- */
function renderPick(){
  const el=$("#svc-pick");
  if(!services.length){
    el.innerHTML="";
  } else {
    const q0=norm($("#svc-busca").value).trim();
    const lista=q0?services.filter(s=>norm(s.nome).includes(q0)):services;
    el.innerHTML=!lista.length?`<div class="svc-list"><div class="svc-none">Nenhum serviço encontrado com “${esc(U($("#svc-busca").value))}”.</div></div>`:`<div class="svc-list">${lista.map(s=>{const q=cart[s.id]||0;return `
      <div class="svc ${q?"on":""}"><div style="min-width:0"><div class="nm">${esc(s.nome)}</div><div class="pr">${money(s.preco)}</div></div>
      <div class="step"><button data-dec="${esc(s.id)}" aria-label="Remover ${esc(s.nome)}">−</button><span class="q">${q}</span><button data-inc="${esc(s.id)}" aria-label="Adicionar ${esc(s.nome)}">+</button></div></div>`}).join("")}</div>`;
  }
  updateTotal();
}
$("#svc-busca").addEventListener("input",()=>{ renderPick(); renderTabela(); });
$("#svc-busca2").addEventListener("input",()=>renderSvcEdit());
$("#svc-pick").addEventListener("click",e=>{
  const i=e.target.closest("[data-inc]"), d=e.target.closest("[data-dec]");
  if(i){cart[i.dataset.inc]=(cart[i.dataset.inc]||0)+1; renderPick();}
  if(d){const k=d.dataset.dec; cart[k]=Math.max(0,(cart[k]||0)-1); if(!cart[k]) delete cart[k]; renderPick();}
});
/* ---------- tabela de preços por tipo de peça (do PDF do ateliê) ---------- */
const TABELA=[["CALÇA JEANS",[["BARRA SIMPLES VIRADA",40.0],["BARRA CORTADA E COSTURADA PARA DESFIAR",35.0],["BARRA ORIGINAL",40.0],["BARRA INFANTIL SEM CORTAR, MANTENDO ORIGINAL",40.0],["AJUSTE DE CÓS",70.0],["AJUSTE LATERAL",50.0],["AJUSTE ENTREPERNAS",40.0],["AJUSTE DE GANCHO",40.0],["AUMENTAR LARGURA DO CÓS COM NESGA",70.0],["COSTURAR PASSANTE",20.0],["TROCA DE ZÍPER",70.0],["COLOCAÇÃO DE BOTÃO JEANS",30.0],["CERZIDO / REPARO",30.0],["BAIXAR O CÓS",90.0],["COLOCAR ELÁSTICO NO CÓS",35.0],["COLOCAR NESGA LATERAL E CÓS",60.0],["COSTURAR BOLSO RASGADO",40.0],["FOLGAR CALÇA SOLTANDO COSTURAS JÁ FEITAS",35.0],["FECHAR RASGADO COM TECIDO E CERZIDO",35.0],["FECHAR BOLSO",10.0],["COMBO — BARRA + AJUSTE DE BOCA",50.0],["COMBO — BARRA + CÓS",80.0],["COMBO — BARRA + LATERAL + GANCHO + CÓS",90.0],["COMBO — BARRA + CÓS + LATERAL",100.0]]],["CALÇA DE TECIDO / ALFAIATARIA",[["BARRA SIMPLES",40.0],["BARRA INVISÍVEL À MÃO",50.0],["BARRA ITALIANA",50.0],["BARRA COM ZÍPER LATERAL",70.0],["BARRA COM ELÁSTICO",50.0],["BARRA SEM CORTAR, PARA DESFIAR DEPOIS",45.0],["BARRA COM FORRO",70.0],["BARRA PANTALONA",80.0],["BARRA SUPOSTA (POR DENTRO)",50.0],["BARRA DE LENÇO EM PANTALONA LARGA",80.0],["COLOCAR FORRO EM TECIDO DA CLIENTE",60.0],["FECHAR BOLSOS",20.0],["FECHAR BOLSO RETIRANDO O TECIDO",30.0],["REFAZER BOLSO",50.0],["TROCAR CÓS",90.0],["AJUSTE DE CINTURA/CÓS",70.0],["AJUSTE LATERAL",50.0],["AJUSTE ENTREPERNAS",60.0],["AJUSTE DE GANCHO",50.0],["AJUSTE DE BOCA DA CALÇA",40.0],["TROCA DE ZÍPER",50.0],["TROCA DE BOTÃO",20.0],["REPARO SIMPLES",15.0],["COLOCAR ELÁSTICO NO CÓS",60.0],["ALARGAR LATERAL COM TECIDO/AVIAMENTO",90.0],["AUMENTAR ELÁSTICO DA CINTURA",30.0],["COLOCAR ELÁSTICO NA CINTURA",40.0],["TRANSFORMAR CALÇA EM SAIA",80.0],["BAIXAR O CÓS",50.0],["COLOCAR NESGA PARA AUMENTAR A CALÇA",60.0],["FOLGAR CALÇA RETIRANDO TECIDO DO CÓS",60.0],["COMBO — BARRA + CÓS",80.0],["COMBO — BARRA + LATERAL",60.0],["COMBO — BARRA + CÓS + LATERAL",90.0],["COMBO — CÓS + LATERAL + BARRA + ENTREPERNAS",110.0]]],["MACACÃO",[["BARRA SIMPLES",40.0],["BARRA MARCAÇÃO PANTALONA",60.0],["BARRA COM ELÁSTICO",45.0],["BARRA RETIRANDO O ELÁSTICO",40.0],["BARRA APLICADA",50.0],["BARRA JEANS APLICADA",50.0],["BARRA DE LENÇO",60.0],["BARRA GALONEIRA",50.0],["BARRA ITALIANA",60.0],["AJUSTE LATERAL",60.0],["SUBIR O CÓS PELO CINTO",70.0],["DIMINUIR O GANCHO",40.0],["AJUSTE DE QUADRIL",60.0],["AJUSTE DE CÓS E QUADRIL",70.0],["AJUSTE NO ZÍPER",50.0],["OMBRO + AJUSTE NO BUSTO",110.0],["OMBRO + AJUSTE LATERAL NA CINTURA",80.0],["OMBRO + CULOTE",70.0],["OMBRO + BARRA",80.0],["RETIRAR BOJO",20.0],["COLOCAR BOJO",35.0],["AJUSTE DE CAVA SIMPLES",40.0],["AJUSTE DE CAVA COM FORRO",60.0],["FECHAR BOLSO",20.0],["COLOCAR FORRO NA PARTE DE BAIXO DA CALÇA",60.0],["RETIRAR PASSANTES",30.0],["TRANSFORMAR BUSTO EM TOMARA QUE CAIA",70.0],["FECHAR DECOTE",35.0],["DESCER DECOTE",40.0],["AJUSTAR ENTREPERNAS",40.0],["FECHAR BOLSOS",20.0],["TROCAR ZÍPER DE 40 CM",45.0],["AJUSTAR MANGA",30.0],["RETIRAR MANGA",40.0],["DIMINUIR PUNHO",50.0],["AJUSTAR GOLA",65.0]]],["BLUSA DE MALHA",[["BARRA SIMPLES GALONEIRA",40.0],["BARRA DE BLUSA POLO COM ABERTURA",50.0],["BARRA CURVADA",50.0],["AJUSTE LATERAL COM ABERTURA",60.0],["BARRA FALSA SEM CORTAR",50.0],["TRANSFORMAR GOLA EM V",30.0],["AJUSTE LATERAL SIMPLES",30.0],["BARRA DA MANGA",30.0],["RETIRAR MANGA",30.0],["FAZER ABERTURA LATERAL",50.0],["SUBIR PUNHO",50.0],["DIMINUIR MANGA LONGA + AJUSTAR LARGURA",50.0],["AJUSTAR MANGA LONGA",35.0],["SUBIR/AJUSTAR OMBRO",40.0],["TRANSFORMAR BLUSA DE MANGA EM REGATA",50.0],["REMOVER GOLA",40.0],["CAVAR GOLA",30.0],["AJUSTE GERAL DA BLUSA",90.0]]],["ABADÁ",[["CUSTOMIZAÇÃO DE ABADÁ",70.0]]],["CAMISA SOCIAL COM BOTÕES",[["AJUSTE LATERAL",50.0],["SUBIR BARRA RETIRANDO CURVA E FAZER LATERAL",55.0],["BARRA RETA/RETANGULAR",40.0],["BARRA SOCIAL CURVADA SEM DETALHE",40.0],["FAZER BOLSO",30.0],["RETIRAR MANGA BUFANTE E TRANSFORMAR EM MANGA NORMAL",60.0],["AJUSTE LATERAL + AJUSTAR MANGA",60.0],["AJUSTE LATERAL + SUBIR OMBRO + AJUSTAR MANGA",80.0],["AJUSTE LATERAL + SUBIR OMBRO + FAZER BARRA + AJUSTAR MANGA",100.0],["VIRAR GOLA",70.0],["AJUSTE LATERAL PESPONTADO",70.0],["BARRA DA MANGA",50.0],["BARRA ITALIANA NA MANGA",60.0],["BARRA DA MANGA APLICANDO PUNHO 3/4",60.0],["BARRA DA MANGA APLICANDO PUNHO COM CARCELA",60.0],["AJUSTAR/SUBIR OMBRO",70.0],["OMBRO + BARRA",70.0],["FAZER PENCES",50.0],["OMBRO + PENCES",70.0],["OMBRO + TROCAR BOTÕES",50.0],["TROCAR BOTÕES NOVOS",40.0],["TROCAR APENAS 1 BOTÃO",20.0],["TROCAR CASA DE BOTÃO NA GOLA",35.0],["COLOCAR ELÁSTICO NAS COSTAS PARA CINTURAR",35.0]]],["JAQUETA JEANS",[["BARRA COM PUNHO E BOTÃO",80.0],["SUBIR OMBRO",80.0],["AJUSTE LATERAL + BARRA",110.0],["AUMENTAR LATERAIS COM TECIDO OU AVIAMENTO",100.0],["AJUSTAR MANGA",70.0],["AUMENTAR MANGA COM TECIDO OU AVIAMENTO",90.0],["AJUSTE LATERAL + MANGA",110.0],["AJUSTE LATERAL + MANGA + BARRA",140.0],["AJUSTAR OMBRO",80.0],["SUBIR PUNHO",80.0],["VIRAR/TROCAR O LADO DA GOLA",80.0],["REPARO DE COSTURA",40.0],["RETIRAR MANGAS E FAZER COLETE",100.0],["TROCAR ZÍPER DA JAQUETA",100.0]]],["JALECO",[["BARRA DO JALECO",50.0],["BORDADO NO JALECO",20.0],["TIRAR A GOLA",40.0],["AJUSTE LATERAL",50.0],["AJUSTE LATERAL COM BOLSOS",50.0],["AJUSTE LATERAL + AJUSTAR MANGA",90.0],["AJUSTAR/SUBIR OMBRO + AJUSTAR MANGA",80.0],["AJUSTE LATERAL + SUBIR OMBRO + BARRA",120.0],["AJUSTE LATERAL + BARRA",80.0],["AJUSTAR MANGA DO JALECO",60.0],["FAZER PUNHOS",25.0],["SUBIR PUNHO",40.0],["AJUSTE LATERAL + SUBIR OMBRO + BARRA MANGA + BARRA",150.0],["TROCAR ZÍPER DO JALECO",70.0],["TROCAR BOLSO DO JALECO",30.0]]],["KIMONO",[["APLICAR PATCHES/ETIQUETA (CADA)",15.0],["REMOVER ETIQUETA (CADA)",10.0],["SUBIR BARRA DO KIMONO",60.0],["AJUSTAR KIMONO PELA LATERAL",50.0],["CERZIR KIMONO",30.0],["TROCAR ELÁSTICO",60.0],["AJUSTAR LATERAIS",50.0],["SUBIR MANGA",50.0],["TROCAR RECORTE ENTREPERNAS",60.0]]],["SUTIÃ",[["AJUSTE NAS COSTAS",30.0],["TROCAR ALÇAS",30.0],["TROCAR REGULADOR DE ALÇA",20.0],["TROCAR REGULADOR/COLCHETE",30.0]]],["BIQUÍNI",[["COLOCAR BOJO SIMPLES",30.0],["AJUSTAR BIQUÍNI",50.0],["AJUSTE COMPLETO DO BIQUÍNI",60.0],["AJUSTAR BUSTO",50.0],["CAVAR COSTAS",50.0],["CAVAR FRENTE",50.0],["CAVAR FRENTE E COSTAS",70.0],["DIMINUIR FUNDO DO BIQUÍNI",60.0],["TROCAR ELÁSTICO DE BIQUÍNI FORRADO",60.0],["AJUSTAR LATERAIS + FUNDO",70.0]]],["MAIÔ",[["AJUSTAR ALÇA",30.0],["AJUSTAR CAVA",30.0],["ACRESCENTAR FAIXA ABAIXO DO BUSTO",50.0],["AJUSTAR LATERAL",40.0],["FECHAR ATRÁS COM UMA TIRA",50.0],["CAVAR EMBAIXO",40.0],["APERTAR O FUNDO",40.0],["AJUSTAR ALÇA + FUNDO",70.0]]],["CINTA",[["AJUSTAR ELÁSTICO",20.0],["AJUSTAR NA PERNA",30.0],["FAZER BARRA DA CINTA",40.0],["AJUSTE + BARRA",80.0]]],["SUNGA DE PRAIA",[["TROCAR ELÁSTICO",40.0],["AJUSTAR LATERAIS",50.0],["CAVAR",35.0],["AUMENTAR LATERAIS",50.0]]],["GRAVATA",[["DIMINUIR GRAVATA",50.0]]],["COLETE",[["AJUSTAR LATERAL — COLETE SIMPLES",50.0],["AJUSTAR LATERAL — COLETE FORRADO",70.0],["AJUSTAR OMBRO",50.0],["AJUSTAR OMBRO + LATERAIS",90.0],["SUBIR BARRA — COLETE SIMPLES",40.0],["SUBIR BARRA — COLETE FORRADO",70.0],["ALARGAR COLETE",70.0],["AJUSTE LATERAL + BARRA",80.0],["TROCAR BOTÕES (CADA)",10.0],["OMBRO + AJUSTE LATERAL",90.0]]],["VESTIDOS DE FESTA",[["BARRA DE VESTIDO DE MUSSELINE",130.0],["AJUSTAR ALÇA SIMPLES",30.0],["RETIRAR TECIDO DA BARRA E FAZER ALÇA",140.0],["AJUSTAR ALÇA EMBUTIDA",40.0],["BARRA COM BABADOS PROFUNDOS",150.0],["BARRA COM BABADO PARA RETIRAR PELA PARTE DE CIMA",130.0],["BARRA COM APLICAÇÃO DE RENDA",130.0],["DESCER A BARRA PARA AUMENTAR O COMPRIMENTO",150.0],["FAZER BARRA PELA CINTURA QUANDO NÃO PODE RETIRAR EMBAIXO",150.0],["BARRA DE VESTIDO DE FESTA COM PAETÊ",150.0],["RETIRAR BOJO",20.0],["COLOCAR BOJO",35.0],["ALÇA + BARRA + AJUSTE",200.0],["AJUSTE DE CINTURA EM VESTIDO FORRADO",80.0],["AJUSTE NO ZÍPER DAS COSTAS",80.0],["FECHAR PARTE DO DECOTE OU BARRA RETIRADA",50.0],["AJUSTAR BUSTO E MODELAR/DESENHAR O PEITO",80.0],["AUMENTAR AS COSTAS COM TECIDO RETIRADO DA BARRA",200.0],["TROCAR ZÍPER EMBUTIDO DO VESTIDO DE FESTA",60.0],["DESCER DECOTE",50.0],["ABRIR FENDA",50.0],["FECHAR FENDA",30.0],["FECHAR VÃO DO VESTIDO COM TECIDO FORNECIDO PELA CLIENTE",50.0],["ADAPTAR TIRAS NAS COSTAS",50.0],["RETIRAR MANGA DO VESTIDO",60.0],["COLOCAR MANGA NO VESTIDO",80.0]]],["SAIAS",[["BARRA SIMPLES",50.0],["BARRA INVISÍVEL À MÃO",70.0],["BARRA DE LENÇO EM SAIA LONGA",100.0],["BARRA APLICADA",70.0],["BARRA DE SAIA JEANS APLICADA/ORIGINAL",50.0],["DESCER BARRA E COLOCAR TECIDO POR DENTRO",90.0],["BARRA DE SAIA DE MALHA NA GALONEIRA",55.0],["BARRA DE SAIA RODADA ACIMA DE 3 METROS",90.0],["CONSERTAR ZÍPER NO FINAL DO ZÍPER",20.0],["AJUSTE LATERAL",60.0],["NESGA",70.0],["TROCAR ZÍPER DE ENCAIXE (SAIA QUE ABRE NA FRENTE)",70.0],["TROCAR ZÍPER COMUM OU INVISÍVEL",40.0],["COLOCAR FORRO COM TECIDO DA CLIENTE",50.0],["AUMENTAR ELÁSTICO DA CINTURA",35.0],["COLOCAR ELÁSTICO",35.0],["AJUSTE DE CÓS",50.0],["AJUSTE DE CINTURA + BARRA",80.0],["FAZER BARRA + COLOCAR NESGA",90.0],["DESCER CÓS",50.0],["FECHAR SAIA ABERTA NA FRENTE COM BOTÕES",50.0],["FAZER FENDA",40.0],["FECHAR FENDA",30.0],["ALARGAR SAIA TODA COM TECIDO/AVIAMENTO",70.0],["COLOCAR PENCES",60.0],["AJUSTAR SAIA DE COURO",70.0],["REFORMA/MODELAGEM",80.0]]],["VESTIDOS — USO COMUM",[["AJUSTE DE ALÇA SIMPLES",30.0],["AJUSTE DE ALÇA EMBUTIDA",40.0],["AJUSTE LATERAL SEM FORRO",40.0],["AJUSTE DE BUSTO FORRADO",50.0],["AJUSTE DE BUSTO SIMPLES",35.0],["AJUSTE DE CINTURA",35.0],["AJUSTE DE QUADRIL",35.0],["TROCA DE ZÍPER COMUM/INVISÍVEL",40.0],["TROCA DE ZÍPER GRANDE DE ENCAIXE",70.0],["BARRA VESTIDO ESTREITO",70.0],["BARRA VESTIDO LARGURA MÉDIA",70.0],["BARRA VESTIDO ACIMA DE 3 METROS",90.0],["APROFUNDAR COSTURA DO BUSTO (FORRADO)",60.0],["COLOCAR BOJO EMBUTIDO (BOJO DA CLIENTE)",30.0],["RETIRAR BOJO",25.0],["COLOCAR ELÁSTICO NA CINTURA",40.0],["DIMINUIR TRONCO DO VESTIDO COM ZÍPER ATRÁS",75.0],["AJUSTAR NO ZÍPER DAS COSTAS",60.0],["FAZER PENCES DOS LADOS NO BUSTO",35.0],["DESCER DECOTE SIMPLES",45.0],["DESCER DECOTE EMBUTIDO",50.0],["FECHAR DECOTE EM V COM TECIDO/AVIAMENTO",50.0],["TROCAR/COLOCAR FORRO EM TECIDO DA CLIENTE",50.0],["RETIRAR FORRO, CORTAR E OVERLOCAR",30.0],["SUBIR OMBRO SIMPLES",35.0],["SUBIR OMBRO FORRADO",50.0],["SUBIR OMBRO COM MANGA E REALOCAR MANGA",60.0],["SUBIR PUNHO COM CARCELA",80.0],["COLOCAR ELÁSTICO PARA AUMENTAR",80.0],["TRANSFORMAR VESTIDO EM SAIA E BLUSA",120.0],["TRANSFORMAR VESTIDO",95.0],["REFORMA/MODELAGEM",100.0],["COLOCAR ELÁSTICO",60.0]]],["BLUSAS FEMININAS",[["AJUSTE DE MANGA",30.0],["DIMINUIR PUNHO",40.0],["AJUSTE LATERAL SIMPLES",35.0],["AJUSTAR OMBRO SIMPLES",30.0],["AJUSTE DE OMBRO FORRADO",50.0],["TROCAR O LADO DO COLARINHO",40.0],["BARRA",30.0],["TROCA DE BOTÃO (CADA)",20.0],["FAZER CASA DE BOTÃO E COLOCAR BOTÃO",20.0],["FAZER PENCES NO BUSTO",35.0]]],["TOP",[["AJUSTE DE TOP FORRADO",70.0],["TROCA DE ZÍPER DE ENCAIXE",70.0],["ALÇA SIMPLES",45.0],["ALÇA/OMBRO EMBUTIDO",65.0],["BARRA SIMPLES",50.0],["BARRA DE TOP FORRADO",70.0],["COLOCAR ELÁSTICO PARA AUMENTAR",80.0]]],["VESTIDOS DE FESTA — SERVIÇOS",[["BARRA DE LENÇO ATÉ 5 METROS",130.0],["BARRA DE LENÇO ACIMA DE 6 METROS",150.0],["BARRA DE LENÇO COM NESGA",180.0],["BARRA DE TULE CORTADA COM FORRO",100.0],["BARRA + AJUSTE SIMPLES",180.0],["BARRA + AJUSTE + ALÇA",200.0],["BARRA + AJUSTE + TROCA DE ZÍPER",250.0],["APLICAR MANGA",70.0],["RETIRAR MANGA",60.0],["TROCAR ZÍPER",70.0],["AJUSTE LATERAL",70.0],["APLICAÇÃO DE BOJO NO VESTIDO FORRADO",30.0]]],["BLAZERS / PALETÓS / TERNOS",[["BARRA DE MANGA SIMPLES SEM FORRO",70.0],["BARRA DE MANGA FORRADA",120.0],["BARRA DE MANGA COM CASA DE BOTÃO",150.0],["SUBIR OMBRO",140.0],["AJUSTE LATERAL SIMPLES SEM FORRO",60.0],["AJUSTE LATERAL FORRADO",120.0],["BARRA DE BLAZER SIMPLES",60.0],["BARRA FORRADA",120.0],["FAZER OU FECHAR FENDA",60.0],["AJUSTE LATERAL + BARRA + BARRA MANGA (SEM FORRO)",120.0],["AJUSTE LATERAL + BARRA + BARRA MANGA (FORRADO)",250.0],["BLAZER FEMININO SEM FORRO EMAGRECER COM TECIDO CLIENTE",80.0],["AJUSTE DE MANGA SEM FORRO",40.0],["AJUSTE DE MANGA",70.0]]],["CASACOS / JAQUETAS / MOLETON",[["AJUSTE DE MANGA SIMPLES",50.0],["AJUSTE LATERAL SIMPLES",50.0],["BARRA",50.0],["TROCA DE ZÍPER DE ENCAIXE DE METAL",70.0],["COSTURA DE FORRO",30.0],["RETIRAR CAPUZ",60.0],["BARRA DE MANGA FORRADA",100.0],["BARRA DE MANGA SIMPLES",60.0]]],["PEÇAS EM MALHA / TRICÔ",[["BARRA DE CALÇA AMPLA/PANTALONA",60.0],["BARRA DE CALÇA DE ACADEMIA/LEGGING",30.0],["AJUSTE LATERAL",40.0],["COLOCAR ELÁSTICO NO CÓS",40.0],["FAZER PENCES",25.0],["AJUSTE MANGA",35.0],["DIMINUIÇÃO DE ALÇA",35.0],["COLOCAÇÃO DE FORRO",50.0]]],["ROUPAS MASCULINAS — CALÇAS",[["BARRA JEANS APLICADA",50.0],["BARRA ELÁSTICO NA PERNA",40.0],["BARRA CALÇA JEANS",50.0],["BARRA INVISÍVEL À MÃO",50.0],["AJUSTE DE CINTURA",60.0],["AJUSTE LATERAL",60.0],["AJUSTE ENTREPERNAS",60.0],["AJUSTE DE GANCHO",50.0],["AJUSTE DE PERNA",50.0],["AJUSTE DE BOCA DA CALÇA",50.0],["CERZIDO/REPARO",20.0],["BARRA + AJUSTE LATERAL",70.0],["BARRA + CÓS CALÇA JEANS",80.0],["BARRA + CÓS CALÇA DE TECIDO",80.0],["BARRA + CÓS + LATERAL",100.0],["FOLGAR CALÇA SOCIAL",40.0]]],["CAMISA SOCIAL MASCULINA",[["AJUSTE LATERAL",40.0],["SUBIR PUNHO COM CARCELA E BOTÃO",60.0],["SUBIR OMBRO",35.0],["OMBRO + LATERAL + BARRA",60.0],["VIRAR/TROCAR LADO DA GOLA",35.0],["TROCAR GOLA COM OUTRO TECIDO",70.0],["AJUSTE LATERAL + MANGA LONGA PESPONTADA",60.0],["AJUSTE LATERAL + MANGA CURTA PESPONTADA",60.0],["PENCE NAS COSTAS",25.0],["AJUSTAR MANGA CURTA SEM PESPONTO",30.0],["AJUSTAR MANGA CURTA COM PESPONTO",40.0],["AJUSTAR MANGA LONGA PESPONTADA",45.0],["AJUSTAR MANGA LONGA SEM PESPONTO",60.0],["REFORMA COMPLETA",100.0],["COLOCAR BOLSO",30.0],["FAZER CASA DE BOTÃO EMBUTIDA NA GOLA",30.0],["BARRA DA CAMISA",30.0],["CORTAR MANGA LONGA E TRANSFORMAR EM CURTA",30.0],["AJUSTE LATERAL + AJUSTE DE MANGA",60.0]]],["BERMUDA",[["AJUSTE LATERAL",40.0],["TROCAR VELCRO",20.0],["AJUSTE DE CÓS + BARRA",60.0],["TROCAR ZÍPER",45.0],["REFORÇAR COSTURAS",40.0],["CERZIDO COM TECIDO POR BAIXO",50.0],["AJUSTE DE CÓS + LATERAL + BARRA",80.0]]],["CONSERTOS GERAIS",[["TROCA DE ZÍPER COMUM DE 20 A 30 CM",40.0],["TROCA DE ZÍPER COMUM DE 40 A 60 CM",50.0],["TROCA DE ZÍPER INVISÍVEL DE 20 A 30 CM",45.0],["TROCA DE ZÍPER INVISÍVEL DE 40 A 60 CM",50.0],["COLOCAÇÃO DE BOTÃO JEANS",20.0],["CASA DE BOTÃO",10.0],["CERZIDO",10.0],["REFORÇO DE COSTURA",10.0],["FECHAMENTO DE RASGO",20.0],["REMENDO",30.0],["TROCAR ELÁSTICO DE SHORT",40.0],["APLICAÇÃO DE VELCRO (A PARTIR DE)",20.0]]],["ALMOFADA",[["COSTURAR ONDE DESCOSTUROU",10.0],["TROCAR CURSOR DE ZÍPER",10.0],["TROCAR ZÍPER",40.0],["FAZER CAPA DE ALMOFADA COM ABERTURA SOBREPOSTA SEM ZÍPER",35.0],["APLICAÇÃO DE AVIAMENTO NA ALMOFADA",10.0],["DIMINUIR A ALMOFADA",30.0],["FAZER ALMOFADA 50 X 30 CM COM NOSSO ZÍPER",45.0],["FAZER ALMOFADA 45 X 45 CM",55.0]]],["LENÇOL",[["FAZER BAINHA POR METRO",15.0],["TROCAR ELÁSTICO INTEIRO",60.0],["TROCAR ELÁSTICO SOMENTE NOS QUATRO CANTOS",40.0],["ADAPTAR LENÇOL E CORTAR OS CANTOS",40.0],["BARRA — SUBIR SOMENTE EM UM LADO",15.0],["FAZER A BAINHA EM TODO O LENÇOL",50.0],["REMENDAR LENÇOL",30.0]]],["CORTINA",[["BARRA LARGA DE CORTINA — POR METRO",20.0],["BARRA FINA/NORMAL DE CORTINA — POR METRO",30.0],["COLOCAR ILHÓS NA PARTE DA ENTRETELA — CADA ILHÓS",15.0],["FAZER CORTINA — POR METRO",60.0]]],["TECIDOS / PEÇAS PARA CASA",[["COBRE-MANCHAS 70 X 60 CM",30.0],["BARRA DE FRALDA — CADA",8.0],["GUARDANAPO COM BAINHA TODA VIRADA — CADA",15.0],["CANTO MITRADO — CADA CANTO",10.0],["BAINHA EM TECIDO — POR METRO",10.0],["PANO DE PRATO — CADA",10.0],["CAPA DE CADEIRA — CADA",70.0]]]];
let tcart={}; const tpOpen=new Set();
const tpKey=(a,b)=>a+"-"+b;
function renderTabela(){
  const box=$("#tp-list"); if(!box) return;
  const q=norm($("#svc-busca").value).trim();
  let html="";
  TABELA.forEach(([peca,its],a)=>{
    const lst=its.map((x,b)=>({x,b})).filter(({x})=>!q || norm(x[0]).includes(q) || norm(peca).includes(q));
    if(!lst.length) return;
    const nSel=its.reduce((t,_,b)=>t+(tcart[tpKey(a,b)]||0),0);
    const aberto = q ? true : tpOpen.has(a);
    html+=`<details class="tp-sec" data-sec="${a}"${aberto?" open":""}><summary><span>${esc(peca)}<br><small>${its.length} serviço${its.length>1?"s":""}</small></span>${nSel?`<span class="sel">${nSel}</span>`:"<span></span>"}<span class="chev" aria-hidden="true">›</span></summary>
      <div class="svc-list">${lst.map(({x,b})=>{ const k=tpKey(a,b), qt=tcart[k]||0; return `<div class="svc ${qt?"on":""}"><div style="min-width:0"><div class="nm">${esc(x[0])}</div><div class="pr">${money(x[1])}</div></div>
      <div class="step"><button type="button" data-tdec="${k}" aria-label="Remover ${esc(x[0])}">−</button><span class="q">${qt}</span><button type="button" data-tinc="${k}" aria-label="Adicionar ${esc(x[0])}">+</button></div></div>`; }).join("")}</div></details>`;
  });
  box.innerHTML = html || (q?`<div class="svc-list"><div class="svc-none">Nenhum serviço da tabela com “${esc(U($("#svc-busca").value))}”.</div></div>`:"");
  const n=Object.values(tcart).reduce((t,v)=>t+v,0);
  $("#tp-count").textContent = n?String(n):"";
}
function tpMostrar(on){ $("#tp-box").hidden=!on; const b=$("#tp-btn"); b.setAttribute("aria-expanded",String(on));
  b.firstChild.textContent = on ? "Esconder tabela de preços" : "Tabela de preços"; }
$("#tp-btn").addEventListener("click",()=>tpMostrar($("#tp-box").hidden));
$("#tp-fechar").addEventListener("click",()=>{ tpMostrar(false); $("#tp-btn").scrollIntoView({behavior:"smooth",block:"center"}); });
$("#tp-list").addEventListener("toggle",e=>{ const d=e.target; if(!d.matches||!d.matches(".tp-sec")||norm($("#svc-busca").value).trim()) return; const a=Number(d.dataset.sec); if(d.open) tpOpen.add(a); else tpOpen.delete(a); },true);
$("#tp-list").addEventListener("click",e=>{
  const i=e.target.closest("[data-tinc]"), d=e.target.closest("[data-tdec]");
  if(i){ const k=i.dataset.tinc; tcart[k]=(tcart[k]||0)+1; }
  else if(d){ const k=d.dataset.tdec; tcart[k]=Math.max(0,(tcart[k]||0)-1); if(!tcart[k]) delete tcart[k]; }
  else return;
  renderTabela(); updateTotal();
});
function tabelaItems(){ return Object.entries(tcart).filter(([,q])=>q>0).map(([k,q])=>{ const [a,b]=k.split("-").map(Number); const peca=TABELA[a][0], x=TABELA[a][1][b];
  return {nome:U(peca+" · "+x[0]), preco:x[1], qtd:q, peca:U(peca)}; }); }
let extras=[]; // serviços fora da tabela: {id,nome,preco,qtd}
let orcs=[];   // serviços em orçamento: {id,nome,qtd}
function cartItems(){ return services.filter(s=>cart[s.id]).map(s=>({nome:U(s.nome), preco:Number(s.preco)||0, qtd:cart[s.id]}))
  .concat(tabelaItems())
  .concat(extras.map(x=>({nome:U(x.nome), preco:Number(x.preco)||0, qtd:x.qtd, avulso:true})))
  .concat(orcs.map(x=>({nome:U(x.nome), preco:0, qtd:x.qtd, orcamento:true}))); }
const temOrc=o=>(o.itens||[]).some(i=>i.orcamento);
function renderOrcs(){
  $("#orc-list").innerHTML = orcs.length ? `<div class="svc-list">${orcs.map(x=>`
    <div class="svc on"><div style="min-width:0"><div class="nm">${esc(U(x.nome))}</div><div class="pr aorcar">A ORÇAR</div></div>
    <div class="step"><button data-odec="${x.id}" aria-label="Diminuir ${esc(x.nome)}">−</button><span class="q">${x.qtd}</span><button data-oinc="${x.id}" aria-label="Aumentar ${esc(x.nome)}">+</button></div></div>`).join("")}</div>` : "";
  updateTotal();
}
$("#orc-add").addEventListener("click",()=>{
  const nome=U($("#orc-nome").value.trim());
  if(!nome){ toast("Descreva o serviço em orçamento."); $("#orc-nome").focus(); return; }
  orcs.push({id:"o"+Date.now().toString(36), nome, qtd:1}); $("#orc-nome").value=""; renderOrcs(); $("#orc-nome").focus();
});
$("#orc-nome").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); $("#orc-add").click(); } });
$("#orc-list").addEventListener("click",e=>{
  const i=e.target.closest("[data-oinc]"), d=e.target.closest("[data-odec]");
  if(i){ const x=orcs.find(y=>y.id===i.dataset.oinc); if(x) x.qtd++; }
  if(d){ const x=orcs.find(y=>y.id===d.dataset.odec); if(x){ x.qtd--; if(x.qtd<=0) orcs=orcs.filter(y=>y!==x); } }
  if(i||d) renderOrcs();
});
function renderExtras(){
  $("#av-list").innerHTML = extras.length ? `<div class="svc-list">${extras.map(x=>`
    <div class="svc on"><div style="min-width:0"><div class="nm">${esc(U(x.nome))}</div><div class="pr">${money(x.preco)} · fora da tabela</div></div>
    <div class="step"><button data-xdec="${x.id}" aria-label="Diminuir ${esc(x.nome)}">−</button><span class="q">${x.qtd}</span><button data-xinc="${x.id}" aria-label="Aumentar ${esc(x.nome)}">+</button></div></div>`).join("")}</div>` : "";
  updateTotal();
}
$("#av-add").addEventListener("click",()=>{
  const nome=U($("#av-nome").value.trim()); const preco=Number($("#av-preco").value);
  if(!nome){ toast("Descreva o serviço."); $("#av-nome").focus(); return; }
  if($("#av-preco").value==="" || !(preco>=0)){ toast("Informe o valor do serviço."); $("#av-preco").focus(); return; }
  extras.push({id:"x"+Date.now().toString(36), nome, preco:round2(preco), qtd:1});
  $("#av-nome").value=""; $("#av-preco").value=""; renderExtras(); $("#av-nome").focus();
});
$("#av-preco").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); $("#av-add").click(); } });
$("#av-list").addEventListener("click",e=>{
  const i=e.target.closest("[data-xinc]"), d=e.target.closest("[data-xdec]");
  if(i){ const x=extras.find(y=>y.id===i.dataset.xinc); if(x) x.qtd++; }
  if(d){ const x=extras.find(y=>y.id===d.dataset.xdec); if(x){ x.qtd--; if(x.qtd<=0) extras=extras.filter(y=>y!==x); } }
  if(i||d) renderExtras();
});
let descTipo="valor";
const round2=v=>Math.round((Number(v)||0)*100)/100;
function calcDesconto(sub){
  const raw=Math.max(0,Number($("#c-desc").value)||0);
  if(!raw) return {desc:0, raw:0, err:""};
  if(descTipo==="pct"){ if(raw>100) return {desc:0, raw, err:"O desconto não pode passar de 100%."}; return {desc:round2(sub*raw/100), raw, err:""}; }
  if(raw>sub) return {desc:0, raw, err:"O desconto é maior que o valor dos serviços."};
  return {desc:round2(raw), raw, err:""};
}
let pagarEm="ato";
function setPagarEm(v){ pagarEm=v; $("#pm-ato").setAttribute("aria-pressed",String(v==="ato")); $("#pm-ret").setAttribute("aria-pressed",String(v==="retirada")); updateTotal(); }
function updateTotal(){
  const it=cartItems(); const sub=round2(it.reduce((a,b)=>a+b.preco*b.qtd,0)); const n=it.reduce((a,b)=>a+b.qtd,0);
  const d=calcDesconto(sub); const tot=round2(sub-d.desc);
  $("#total").textContent=money(tot);
  const was=$("#total-was"); was.hidden=!d.desc; was.textContent=d.desc?money(sub):"";
  $("#cart-count").textContent = n? `${n} selecionado${n>1?"s":""}` : "";
  const box=$("#sumbox");
  const sinal = pagarEm==="ato" ? 0 : Math.max(0,Number($("#c-entrada").value)||0);
  $("#f-entrada").hidden = pagarEm==="ato";
  $("#f-pag").hidden = pagarEm!=="ato" && !sinal;
  $("#c-pag-lbl").textContent = pagarEm==="ato" ? "Forma de pagamento" : "Forma de pagamento do sinal";
  const nOrc=orcs.reduce((a,x)=>a+x.qtd,0);
  if(!sub && !d.raw && !nOrc){ box.innerHTML=""; return; }
  const lbl = descTipo==="pct" && d.raw ? `Desconto (${String(d.raw).replace(".",",")}%)` : "Desconto";
  box.innerHTML=`<div><span>Serviços</span><span>${money(sub)}</span></div>
    ${d.desc?`<div class="disc"><span>${lbl}</span><span>− ${money(d.desc)}</span></div>`:""}
    ${nOrc?`<div class="pay"><span>${nOrc} serviço${nOrc>1?"s":""} em orçamento</span><span>a orçar</span></div>`:""}
    <div class="tot"><span>Total${nOrc?" (sem o orçamento)":""}</span><span>${money(tot)}</span></div>
    ${pagarEm==="ato" ? `<div><span>Pago no ato (${esc($("#c-pag").value)})</span><span>${money(tot)}</span></div>`
      : `${sinal?`<div><span>Sinal (${esc($("#c-pag").value)})</span><span>${money(sinal)}</span></div>`:""}<div class="pay"><span><b>A pagar na retirada</b></span><span><b>${money(Math.max(0,round2(tot-sinal)))}</b></span></div>`}
    ${d.err?`<div class="err">${d.err}</div>`:""}${pagarEm!=="ato"&&sinal>tot+0.001?`<div class="err">O sinal é maior que o total do pedido.</div>`:""}`;
}
function setDescTipo(t){ descTipo=t; $("#dt-valor").setAttribute("aria-pressed",String(t==="valor")); $("#dt-pct").setAttribute("aria-pressed",String(t==="pct"));
  $("#c-desc").placeholder = t==="pct" ? "0 %" : "0,00"; $("#c-desc").step = t==="pct" ? "1" : "0.01"; updateTotal(); }
$("#dt-valor").addEventListener("click",()=>setDescTipo("valor"));
$("#dt-pct").addEventListener("click",()=>setDescTipo("pct"));
$("#c-desc").addEventListener("input",updateTotal);
$("#c-entrada").addEventListener("input",updateTotal);
$("#c-pag").addEventListener("change",updateTotal);
$("#pm-ato").addEventListener("click",()=>setPagarEm("ato"));
$("#pm-ret").addEventListener("click",()=>setPagarEm("retirada"));

/* ---------- atendimento: fotos ---------- */
function renderPhotos(){
  $("#photo-thumbs").innerHTML = photos.map((p,i)=>`<div class="thumb"><img src="${p.url}" alt="Foto ${i+1}"><button class="x" data-rm="${i}" aria-label="Remover foto">×</button></div>`).join("");
}
async function addPhotos(files){
  for(const f of files){
    if(photos.length>=6){toast("Limite de 6 fotos."); break;}
    if(!/^image\//.test(f.type||"image/") || f.size>30*1024*1024){ toast("Esse arquivo não é uma foto válida (até 30 MB)."); continue; }
    try{ const b=await compressImage(f); photos.push({blob:b,url:URL.createObjectURL(b)}); }catch(e){toast("Não consegui abrir essa imagem.");}
  }
  renderPhotos();
}
$("#ph-cam").addEventListener("change",e=>{addPhotos([...e.target.files]); e.target.value="";});
$("#ph-gal").addEventListener("change",e=>{addPhotos([...e.target.files]); e.target.value="";});
$("#photo-thumbs").addEventListener("click",e=>{const b=e.target.closest("[data-rm]"); if(!b) return; const p=photos.splice(+b.dataset.rm,1)[0]; URL.revokeObjectURL(p.url); renderPhotos();});

/* ---------- atendimento: áudio ---------- */
function renderAudio(){
  $("#audio-btn-txt").textContent = audio ? "Gravar outro áudio" : "Gravar áudio";
  $("#audio-slot").innerHTML = audio ? `<div class="audio-box"><audio controls src="${audio.url}"></audio><button class="btn ghost danger" id="au-rm">Remover áudio</button></div>` : "";
  if(audio) $("#au-rm").onclick=()=>{URL.revokeObjectURL(audio.url); audio=null; renderAudio();};
}
$("#au-in").addEventListener("change",e=>{
  const f=e.target.files[0]; e.target.value=""; if(!f) return;
  if(f.size>6*1024*1024){toast("Áudio muito grande. Grave um mais curto (até 6 MB)."); return;}
  (async()=>{
    if(f.type && !TIPOS_AUDIO.test(String(f.type).toLowerCase().split(";")[0])){ toast("Esse arquivo não é um áudio aceito."); return; }
    if(!(await audioValido(f))){ toast("Esse arquivo não é um áudio válido."); return; }
    if(audio) URL.revokeObjectURL(audio.url);
    audio={blob:f.type?f:new Blob([f],{type:"audio/mp4"}),url:URL.createObjectURL(f)}; renderAudio();
  })();
});

/* ---------- finalizar ---------- */
$("#finalizar").addEventListener("click", finalizar);
async function finalizar(){
  if(saving) return;
  const nome=$("#c-nome").value.trim(); const itens=cartItems();
  if(!nome){toast("Informe o nome da cliente."); $("#c-nome").focus(); return;}
  if(!itens.length){toast("Selecione pelo menos um serviço."); return;}
  if(!db){toast("Ainda conectando ao ateliê. Tente em instantes."); return;}
  { const sub=round2(itens.reduce((a,b)=>a+b.preco*b.qtd,0)); const dc=calcDesconto(sub); if(dc.err){ toast(dc.err); $("#c-desc").focus(); return; }
    const ent=pagarEm==="ato"?0:(Number($("#c-entrada").value)||0); if(ent>round2(sub-dc.desc)+0.001){ toast("O sinal é maior que o total do pedido."); $("#c-entrada").focus(); return; } }
  if(entregaTipo==="entrega" && !$("#c-end").value.trim()){ toast("Informe o endereço de entrega."); $("#c-end").focus(); return; }
  saving=true; const btn=$("#finalizar"); btn.disabled=true;
  const setBusy=t=>btn.innerHTML=`<span class="busy"><span class="spin"></span>${t}</span>`;
  try{
    const fotoIds=[];
    for(let i=0;i<photos.length;i++){ setBusy(`Enviando foto ${i+1}/${photos.length}`); fotoIds.push(await saveBlob(photos[i].blob,"foto")); }
    let audioId=null;
    if(audio){ setBusy("Enviando áudio"); audioId=await saveBlob(audio.blob,"audio"); }
    setBusy("Gerando nota");
    const code=newCode(); const now=Date.now(); const atend=session?session.nome:"";
    const subtotal=round2(itens.reduce((a,b)=>a+b.preco*b.qtd,0)); const dc=calcDesconto(subtotal);
    const total=round2(subtotal-dc.desc);
    const pedido={codigo:code, cliente:{nome:U(nome), telefone:telCompleto()},
      itens, subtotal, desconto:dc.desc, descontoTipo:descTipo, descontoInformado:dc.raw, total,
      pagarEm, entrada: pagarEm==="ato" ? total : Math.min(total,Math.max(0,Number($("#c-entrada").value)||0)),
      pagamento: (pagarEm==="ato" || (Number($("#c-entrada").value)||0)>0) ? $("#c-pag").value : "Pagar na retirada",
      prioridade: prioNovo,
      entrega:$("#c-entrega").value||"", entregaTipo, endereco: entregaTipo==="entrega"?U($("#c-end").value.trim()):"",
      obs:U($("#c-obs").value.trim()), fotos:fotoIds, audio:audioId,
      atendente:atend, costureira:"", status:"recebido", criadoEm:now,
      historico:[{status:"recebido", por:atend||"Atendimento", em:now}]};
    await db.doc(`pedidos/${code}`).set(pedido);
    saveCliente(pedido.cliente.nome, pedido.cliente.telefone, pedido.endereco);
    try{ resetForm(); }catch(e){ console.error(e); }
    try{ await openOrder(code, pedido); }catch(e){ console.error(e); }
    toast("Pedido "+code+" finalizado. Envie o pedido pelo WhatsApp.");
    setTimeout(()=>{ const w=$("#sheet .wa-box"); if(w) w.scrollIntoView({behavior:"smooth",block:"center"}); },500);
  }catch(e){ writeErr(e); }
  finally{ saving=false; btn.disabled=false; btn.textContent="Finalizar pedido"; }
}
function resetForm(){
  orcs=[]; $("#orc-nome").value=""; renderOrcs(); setPrioNovo(false);
  $("#c-end").value=""; setEntrega("retirada");
  pagarEm="ato"; $("#pm-ato").setAttribute("aria-pressed","true"); $("#pm-ret").setAttribute("aria-pressed","false"); $("#c-pag").value="Pix";
  autoNome=""; $("#c-found").hidden=true;
  extras=[]; $("#av-nome").value=""; $("#av-preco").value=""; renderExtras();
  ["#c-nome","#c-tel","#c-entrega","#c-obs","#c-entrada","#c-desc","#svc-busca"].forEach(s=>$(s).value=""); $("#c-ddi").value="+55"; $("#c-tel").placeholder="(81) 9 9999-9999"; $("#c-tel-hint").hidden=true; descTipo="valor"; setDescTipo("valor");
  cart={}; tcart={}; tpOpen.clear(); renderTabela(); tpMostrar(false); photos.forEach(p=>URL.revokeObjectURL(p.url)); photos=[]; if(audio) URL.revokeObjectURL(audio.url); audio=null;
  renderPick(); renderPhotos(); renderAudio();
}

/* ---------- listas de pedidos ---------- */
const ehPrio=o=>!!o.prioridade && o.status!=="entregue";
function ordCls(o){ return (ehPrio(o)?" prio":"")+((session&&session.papel!=="costureira"&&o.status!=="entregue"&&restOf(o)>0.001)?" devendo":""); }
const prioTag=o=>ehPrio(o)?`<span class="tag-prio">PRIORIDADE</span>`:"";
const prioPrim=(a,b)=>(ehPrio(b)?1:0)-(ehPrio(a)?1:0);
function ordCard(o){
  const qt=(o.itens||[]).reduce((a,b)=>a+b.qtd,0);
  const icons=`${(o.fotos||[]).length?'<svg aria-label="tem foto"><use href="#i-img"/></svg>':""}${o.audio?'<svg aria-label="tem áudio"><use href="#i-mic"/></svg>':""}`;
  return `<button class="ord${ordCls(o)}" data-open="${esc(o.codigo)}"><span class="stripe ${o.status}"></span>
    <span class="mid"><span class="row" style="gap:8px"><span class="code">${esc(o.codigo)}</span>${prioTag(o)}${o.retornoDe||o.emRetorno?`<span class="tag-ret">RETORNO</span>`:""}${comEntrega(o)?`<span class="tag-ent">ENTREGA</span>`:""}${temOrc(o)&&!(session&&session.papel==="costureira")?`<span class="tag-orc">ORÇAMENTO</span>`:""}${(session&&session.papel!=="costureira"&&o.status!=="entregue"&&restOf(o)>0.001)?`<span class="pay-tag">A PAGAR</span>`:""}<span class="ic">${icons}</span></span>
    <span class="who">${esc(o.cliente?.nome)}</span>
    <span class="sub">${qt} serviço${qt>1?"s":""} · ${lateTxt(o)}${o.costureira?" · "+esc(o.costureira):""}</span>${o.local?`<span><span class="loc">Local: ${esc(o.local)}</span></span>`:""}</span>
    <span class="pill st-${o.status}">${STATUS[o.status]||o.status}</span></button>`;
}
function renderRecent(){
  const el=$("#recent"); const list=orders.slice(0,12);
  el.innerHTML = list.length ? list.map(ordCard).join("") : `<div class="empty">Os pedidos finalizados aparecem aqui.</div>`;
}
function renderQueue(){
  const counts={ativos:0,recebido:0,em_costura:0,pronto:0,entregue:0};
  orders.forEach(o=>{counts[o.status]=(counts[o.status]||0)+1; if(o.status!=="entregue") counts.ativos++;});
  const fl=[["ativos","Em aberto"],["recebido","Recebidos"],["em_costura","Em costura"],["pronto","Prontos"],["entregue","Entregues"]];
  $("#filters").innerHTML=fl.map(([k,l])=>`<button class="chip" data-f="${k}" aria-pressed="${filter===k}">${l}<span class="n">${counts[k]||0}</span></button>`).join("");
  let list = filter==="ativos" ? orders.filter(o=>o.status!=="entregue") : orders.filter(o=>o.status===filter);
  if(filter==="ativos"||filter==="recebido") list=[...list].sort((a,b)=>(a.entrega||"9")<(b.entrega||"9")?-1:1);
  list=[...list].sort(prioPrim);
  $("#queue").innerHTML = list.length ? list.map(ordCard).join("") : `<div class="empty">Nenhum pedido nesta lista.</div>`;
}
$("#filters").addEventListener("click",e=>{const b=e.target.closest("[data-f]"); if(!b) return; filter=b.dataset.f; renderQueue();});
document.addEventListener("click",e=>{const b=e.target.closest("[data-open]"); if(b) openOrder(b.dataset.open);});

/* ---------- impressão (PDF) ---------- */
let logoJpg=null;
async function getLogo(){
  if(logoJpg) return logoJpg;
  const el=document.querySelector(".logo"); const m=el && getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)$/);
  if(!m) return null;
  const img=await new Promise((res,rej)=>{const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=m[1];});
  const c=document.createElement("canvas"); c.width=img.naturalWidth; c.height=img.naturalHeight; const x=c.getContext("2d");
  x.fillStyle="#fff"; x.fillRect(0,0,c.width,c.height); x.drawImage(img,0,0);
  logoJpg={src:c.toDataURL("image/jpeg",.92), r:c.height/c.width}; return logoJpg;
}
function qrPng(code){
  const d=document.createElement("div"); d.style.cssText="position:absolute;left:-9999px;top:0";
  document.body.appendChild(d);
  new QRCode(d,{text:qrText(code),width:400,height:400,colorDark:"#000000",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.Q});
  const cv=d.querySelector("canvas"); const url=cv?cv.toDataURL("image/png"):null; d.remove(); return url;
}
function layoutNota(doc,o,fmt,logo,qr){
  const thermal=fmt==="80"; const W=thermal?80:210; const M=thermal?4:18; const R=W-M; const CW=R-M;
  const fs=thermal?{t:11,b:8.5,s:7.5,big:13}:{t:16,b:10.5,s:9,big:16};
  const lh=k=>k*0.42; let y=M;
  const plum=[156,53,103], teal=[43,156,142], grey=[100,112,121], ink=[33,33,40];
  const T=(txt,x,yy,opt={})=>doc.text(Array.isArray(txt)?txt:String(txt),x,yy,opt);
  const font=(sz,st="normal",col=ink)=>{doc.setFont("helvetica",st); doc.setFontSize(sz); doc.setTextColor(...col);};
  const hr=(dash)=>{ doc.setDrawColor(...(dash?teal:[200,210,210])); doc.setLineWidth(thermal?.25:.3); if(dash&&doc.setLineDashPattern) doc.setLineDashPattern([1.2,1],0); doc.line(M,y,R,y); if(doc.setLineDashPattern) doc.setLineDashPattern([],0); };
  // cabeçalho
  if(logo){ const lw=thermal?44:52, lh_=lw*logo.r; const lx=thermal?(W-lw)/2:M; doc.addImage(logo.src,"JPEG",lx,y,lw,lh_); 
    if(thermal){ y+=lh_+4; }
    else { font(fs.s,"normal",grey); const ax=R; T("Galeria Jaqueira Park Center",ax,y+8,{align:"right"}); T("R. do Futuro, 913 · Graças · Recife/PE",ax,y+12.5,{align:"right"}); font(fs.s,"bold",teal); T("WhatsApp (81) 99616-0055",ax,y+17,{align:"right"}); y+=lh_+5; } }
  if(thermal){ font(fs.s,"normal",grey); T("Galeria Jaqueira Park Center",W/2,y,{align:"center"}); y+=3.4; T("R. do Futuro, 913 · Graças · Recife/PE",W/2,y,{align:"center"}); y+=3.4; font(fs.s,"bold",teal); T("WhatsApp (81) 99616-0055",W/2,y,{align:"center"}); y+=4.5; }
  hr(true); y+=thermal?5:7;
  font(fs.t,"bold",plum); T("PEDIDO",thermal?W/2:M,y,{align:thermal?"center":"left"});
  if(!thermal){ font(fs.b,"bold",ink); T("Nº "+o.codigo,R,y,{align:"right"}); }
  y+=thermal?5:6;
  font(fs.s,"normal",grey);
  if(thermal){ font(fs.b,"bold",ink); T("Nº "+o.codigo,W/2,y,{align:"center"}); y+=4; font(fs.s,"normal",grey); T("Emitida em "+fmtDate(o.criadoEm),W/2,y,{align:"center"}); }
  else T("Emitida em "+fmtDate(o.criadoEm),R,y,{align:"right"});
  y+=thermal?5:8;
  // dados
  const c=o.cliente||{};
  const kv=[["Cliente",c.nome],["Telefone",c.telefone],[comEntrega(o)?"Data da entrega":"Retirada prevista",o.entrega?fmtDay(diaAntes(o.entrega)):""],["Entrega",comEntrega(o)?"FAZER ENTREGA":"CLIENTE RETIRA NO ATELIÊ"],["Endereço",comEntrega(o)?o.endereco:""],["Atendente",o.atendente],["Costureira",o.costureira],["Local da peça",o.local]].filter(r=>r[1]).map(([k,v])=>[k,U(v)]);
  const kx=M+(thermal?26:36);
  kv.forEach(([k,v])=>{ font(fs.b,"normal",grey); T(k,M,y); font(fs.b,"bold",ink); const lines=doc.splitTextToSize(String(v),R-kx); T(lines,kx,y); y+=lh(fs.b)*1.35*lines.length+ (thermal?.6:1.2); });
  y+=thermal?2:4;
  // itens (sem valores)
  const cQ=R;
  font(fs.s,"bold",teal); T("SERVIÇO",M,y); T("QTD",cQ,y,{align:"right"});
  y+=1.8; hr(false); y+=thermal?3.8:5;
  (o.itens||[]).forEach(i=>{
    const nameW=cQ-12-M; font(fs.big-1,"bold",ink); const lines=doc.splitTextToSize(U(i.nome),nameW); T(lines,M,y);
    T(i.qtd+"×",cQ,y,{align:"right"});
    y+=lh(fs.big-1)*1.3*lines.length+(thermal?1.6:2.6);
  });
  hr(false); y+=thermal?5:7;
  if(o.obs){ font(fs.s,"bold",teal); T("OBSERVAÇÕES",M,y); y+=thermal?3.8:5; font(fs.b,"normal",ink); const lines=doc.splitTextToSize(U(o.obs),CW); T(lines,M,y); y+=lh(fs.b)*1.35*lines.length+(thermal?3:5); }
  hr(true); y+=thermal?4:7;
  // QR
  const qs=thermal?34:38;
  if(thermal){ if(qr) doc.addImage(qr,"PNG",(W-qs)/2,y,qs,qs); y+=qs+3; font(fs.t,"bold",ink); T(o.codigo,W/2,y+1,{align:"center"}); y+=5; font(fs.s,"normal",grey); T("Apresente este código para retirar a peça.",W/2,y,{align:"center"}); y+=6; }
  else { if(qr) doc.addImage(qr,"PNG",M,y,qs,qs); font(fs.s,"bold",teal); T("CÓDIGO DO PEDIDO",M+qs+8,y+12); font(20,"bold",ink); T(o.codigo,M+qs+8,y+21); font(fs.b,"normal",grey); T("Apresente este código para retirar a peça.",M+qs+8,y+28); y+=qs+8; }
  font(fs.s,"normal",grey); T("Comprovante interno do ateliê · sem valor fiscal",W/2,y,{align:"center"}); y+=M;
  return y;
}
async function buildNotaPdf(o,fmt){
  if(!window.jspdf) throw new Error("jspdf");
  const {jsPDF}=window.jspdf; const logo=await getLogo().catch(()=>null); const qr=qrPng(o.codigo);
  let doc;
  if(fmt==="80"){ const probe=new jsPDF({unit:"mm",format:[80,1000]}); const h=Math.ceil(layoutNota(probe,o,fmt,logo,qr)); doc=new jsPDF({unit:"mm",format:[80,Math.max(120,h)],compress:true}); }
  else doc=new jsPDF({unit:"mm",format:"a4",compress:true});
  layoutNota(doc,o,fmt,logo,qr);
  doc.setProperties({title:"Pedido "+o.codigo+" · Costura Expressa"});
  return doc.output("blob");
}
function printBrowser(o){
  let area=$("#print-area"); if(!area){ area=document.createElement("div"); area.id="print-area"; document.body.appendChild(area); }
  area.className="force-light";
  area.innerHTML=notaHTML(o,{precos:false, qr:true, interna:true}).replace('id="qr"','id="qr-print"');
  try{ new QRCode(area.querySelector("#qr-print"),{text:qrText(o.codigo),width:240,height:240,colorDark:"#000000",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.Q}); }catch(e){}
  setTimeout(()=>window.print(),150);
}
async function printImagem(o){
  if(!window.html2canvas) throw new Error("html2canvas");
  const box=document.createElement("div"); box.className="force-light print-render";
  box.innerHTML=notaHTML(o,{precos:false, qr:true, interna:true}).replace('id="qr"','id="qr-pr"');
  document.body.appendChild(box);
  try{
    new QRCode(box.querySelector("#qr-pr"),{text:qrText(o.codigo),width:300,height:300,colorDark:"#000000",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.Q});
    await new Promise(r=>setTimeout(r,60));
    const cv=await html2canvas(box.querySelector(".nota"),{scale:1,backgroundColor:"#ffffff",logging:false,width:576,windowWidth:576});
    return await new Promise((res,rej)=>cv.toBlob(b=>b?res(b):rej(new Error("imagem")),"image/png"));
  } finally { box.remove(); }
}
function wirePrint(o){
  let img=null; const pb=$("#print-now"), pm=$("#print-msg");
  const html=pb.innerHTML; pb.disabled=true; pb.innerHTML='<span class="busy"><span class="spin"></span>Preparando a impressão</span>';
  printImagem(o).then(b=>{ img=new File([b],`pedido-${o.codigo}.png`,{type:"image/png"}); })
    .catch(e=>{ console.warn(e); pm.textContent="Não consegui preparar a impressão. Use Imprimir pelo navegador."; })
    .finally(()=>{ pb.disabled=false; pb.innerHTML=html; });
  $("#print-browser").onclick=()=>printBrowser(o);
  pb.onclick=async()=>{
    if(img && navigator.canShare && navigator.canShare({files:[img]})){
      try{ await navigator.share({files:[img]}); pm.textContent="Escolha o Fun Print na lista e toque em imprimir."; return; }
      catch(e){ if(e && e.name==="AbortError") return; }
    }
    if(img){ saveFile(img,img.name); pm.textContent="Imagem baixada ("+img.name+"). Abra o Fun Print e escolha essa imagem para imprimir."; return; }
    printBrowser(o);
  };
}
async function printNota(code,fmt,btn){
  const o=orders.find(x=>x.codigo===code); const msg=$("#print-msg");
  if(!o) return;
  if(!window.jspdf){ msg.textContent="O gerador de PDF não carregou. Verifique a internet e abra a nota de novo."; return; }
  const old=btn.textContent; btn.disabled=true; btn.innerHTML='<span class="busy"><span class="spin"></span>Gerando PDF</span>';
  try{
    const blob=await buildNotaPdf(o,fmt);
    saveFile(blob,`pedido-${code}${fmt==="80"?"-termica":""}.pdf`);
    msg.textContent="PDF baixado. Abra o arquivo e toque em Imprimir.";
  }catch(e){
    console.error(e);
    msg.textContent = e && e.code==="declined" ? "O download foi cancelado. Toque de novo para gerar a nota." : "Não consegui baixar o PDF por aqui. Use o botão Abrir nota para imprimir.";
  }finally{ btn.disabled=false; btn.textContent=old; }
}

let ivBlob=null, ivCode="";
/* ---------- WhatsApp ---------- */
const waIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3Z"/></svg>';
function waNumber(tel){
  const t=String(tel||"").trim();
  let d=t.replace(/\D/g,"");
  if(!d) return "";
  if(t.startsWith("+") || t.startsWith("00")){ d=d.replace(/^00/,""); return d.length>=8 && d.length<=15 ? d : ""; }
  d=d.replace(/^0+/,"");
  if(d.startsWith("55") && d.length>=12) return d;
  if(d.length===10 || d.length===11) return "55"+d;
  if(d.length===8 || d.length===9) return "5581"+d;
  return d.length>=10 ? d : "";
}
const ehCelular=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent||"");
const ehAndroid=/Android/i.test(navigator.userAgent||"");
// No Android abre sempre o WhatsApp Business (pacote com.whatsapp.w4b), nunca o WhatsApp normal.
function waLink(tel,text){ const n=waNumber(tel);
  if(ehAndroid) return "intent://send/?phone="+(n||"")+"&text="+encodeURIComponent(text)+"#Intent;scheme=whatsapp;package=com.whatsapp.w4b;end";
  return ehCelular ? "whatsapp://send?phone="+(n||"")+"&text="+encodeURIComponent(text) : "https://wa.me/"+(n||"")+"?text="+encodeURIComponent(text); }
function abrirWA(tel,text){ const u=waLink(tel,text); if(ehCelular) location.href=u; else window.open(u,"_blank","noopener"); }
function linkPedido(o){ const base=location.href.split("#")[0].split("?")[0].replace(/[^/]*$/,""); return base+"pedido.html?c="+o.codigo; }
function publicoDe(o){
  return { codigo:o.codigo, cliente:U(String((o.cliente||{}).nome||"").trim()), itens:(o.itens||[]).map(i=>({nome:U(i.nome), qtd:i.qtd, preco:Number(i.preco)||0, ...(i.orcamento?{orcamento:true}:{})})),
    subtotal:subOf(o), desconto:descOf(o), descontoLabel:descLabel(o), total:totOf(o), entrada:Number(o.entrada)||0, pagamento:o.pagamento||"",
    pagoNoAto:pagoNoAto(o), restante:restOf(o), ondePaga:ondePaga(o), entrega:o.entrega||"", comEntrega:comEntrega(o),
    obs:U(o.obs||""), status:o.status, criadoEm:o.criadoEm||0, atualizadoEm:Date.now() };
}
function publicar(o){ if(!db) return; const cur=orders.find(x=>x.codigo===o.codigo)||o; db.doc(`publico/${o.codigo}`).set(publicoDe(cur)).catch(e=>console.warn(e)); }
function waEntregueText(o){
  const nome=U(String((o.cliente||{}).nome||"").trim());
  return [`Olá${nome?", *"+nome+"*":""}!`,"",
    "Somos da @Costuraexpressa_,",
    `estamos passando para avisar que o seu pedido *${o.codigo}* foi entregue${comEntrega(o)?" no endereço informado":""}! ✅🧵`,"",
    "*IMPORTANTE*",
    "Caso seja necessário alguma alteração, o prazo de retorno para os serviços prestados é de *7 dias corridos*.","",
    "Agradecemos a preferência!📌✂️"].join("\n");
}
function waNotaText(o){
  const c=o.cliente||{}; const nome=String(c.nome||"").trim().split(/\s+/)[0]||"";
  const L=[];
  L.push(`Olá${nome?", "+nome:""}! Aqui é da *Costura Expressa*.`);
  L.push(""); L.push(`*Pedido Nº ${o.codigo}*`); L.push(`Data: ${fmtDate(o.criadoEm)}`); L.push("");
  (o.itens||[]).forEach(i=>L.push(`• ${i.qtd}× ${U(i.nome)}: ${i.orcamento?"em orçamento (valor a definir)":money(i.preco*i.qtd)}`));
  L.push("");
  if(descOf(o)){ L.push(`Subtotal: ${money(subOf(o))}`); L.push(`${descLabel(o)}: - ${money(descOf(o))}`); }
  L.push(`*Total: ${money(totOf(o))}*`);
  if(pagoNoAto(o)) L.push(`Pago no ato (${o.pagamento}): ${money(o.entrada)}`);
  else {
    if(Number(o.entrada)) L.push(`Sinal (${o.pagamento}): ${money(o.entrada)}`);
    if(o.status==="entregue") L.push("Situação: quitado");
    else if(restOf(o)>0.001) L.push(`A pagar ${ondePaga(o)}: ${money(restOf(o))}`);
  }
  if(comEntrega(o)){ L.push(`Entrega no endereço${o.entrega?" em "+fmtDay(o.entrega):""}: ${U(o.endereco||"")}`); }
  else if(o.entrega) L.push(`Retirada prevista: ${fmtDay(o.entrega)}`);
  if(o.obs){ L.push(""); L.push(`Observações: ${U(o.obs)}`); }
  L.push(""); L.push(`Para retirar a peça, apresente o código *${o.codigo}*.`);
  L.push(""); L.push("Galeria Jaqueira Park Center, R. do Futuro, 913, Graças, Recife/PE"); L.push("WhatsApp (81) 99616-0055");
  return L.join("\n");
}
function waProntoText(o){
  const c=o.cliente||{}; const nome=U(String(c.nome||"").trim());
  return [
    `Olá${nome?", *"+nome+"*":""}!`,
    "",
    "Somos da @Costuraexpressa_,",
    "estamos passando para avisar que sua roupa está pronta!👏🏻🪡🧵",
    "",
    `Pedido: *${o.codigo}*`,
    "",
    "*IMPORTANTE*",
    "Ao buscar suas peças em nosso atelier, caso seja necessário alguma alteração, o prazo de retorno para os serviços prestados é de *7 dias corridos*.",
    "",
    "⏰Segue nossos horários:",
    "",
    "Segunda: 09h às 18h",
    "Terça à Sexta: 08h às 18h",
    "Sábado: 08h às 17h",
    "",
    "Agradecemos a preferência!📌✂️"
  ].join("\n");
}
function wireWhats(o){
  const ap=$("#wa-pronto"), inp=$("#wa-tel");
  const refresh=()=>{
    const tel = inp ? inp.value : (o.cliente||{}).telefone;
    const ok=!!waNumber(tel);

    if(ap){ ap.href=waLink(tel,waProntoText(o)); ap.setAttribute("aria-disabled",String(!ok)); }
  };
  if(inp) inp.addEventListener("input",refresh);
  refresh();
  const mark=async(field,extra)=>{
    try{
      const patch={[field]:Date.now(), ...extra};
      if(inp && waNumber(inp.value) && inp.value.trim()!==String((o.cliente||{}).telefone||"").trim()) patch.cliente={...(o.cliente||{}), telefone:inp.value.trim()};
      await db.doc(`pedidos/${o.codigo}`).update(patch);
    }catch(e){ console.warn(e); }
  };
  if(ap) ap.addEventListener("click",()=>mark("whatsProntoEm"));
  // prepara a imagem do pedido (sem QR) assim que a nota abre, para copiar/compartilhar na hora do toque
  let img=null; const ib=$("#wa-img"), pm=$("#wa-msg");
  const ibHtml=ib.innerHTML; ib.disabled=true; ib.innerHTML='<span class="busy"><span class="spin"></span>Preparando a imagem</span>';
  clienteImagem(o).then(b=>{ img=new File([b],`pedido-${o.codigo}.png`,{type:"image/png"}); })
    .catch(e=>{ console.error(e); pm.textContent="Não consegui gerar a imagem agora. Verifique a internet e abra o pedido de novo."; })
    .finally(()=>{ ib.disabled=false; ib.innerHTML=ibHtml; });
  const legenda=()=>{ const nome=String((o.cliente||{}).nome||"").trim().split(/\s+/)[0]||""; return `Olá${nome?", "+nome:""}! Segue o seu pedido ${o.codigo} da Costura Expressa.`; };
  const podeArquivo=()=>{ try{ return !!(img && navigator.canShare && navigator.canShare({files:[img]})); }catch(e){ return false; } };
  const telAtual=()=> inp ? inp.value : (o.cliente||{}).telefone;
  const nomeCli=String((o.cliente||{}).nome||"").trim()||"a cliente";
  // jeito 1 (celular): compartilhar a imagem com a mensagem junto
  const enviarCompartilhando=async()=>{
    try{ await navigator.share({files:[img], text:legenda()}); mark("whatsEnviadoEm");
      pm.innerHTML=`Enviado. Se ainda não escolheu, toque em <b>WhatsApp</b> e procure <b>${esc(nomeCli)}</b>${telAtual()?" ("+esc(telAtual())+")":""}.`; return true; }
    catch(e){ if(e && e.name==="AbortError") return true; console.warn(e); return false; }
  };
  // jeito 2: copiar a imagem e abrir a conversa da cliente
  const enviarCopiando=async()=>{
    const tel=telAtual();
    if(!waNumber(tel)){ toast("Informe o WhatsApp da cliente."); if(inp) inp.focus(); return; }
    let copiou=false;
    try{ if(navigator.clipboard && window.ClipboardItem){ await navigator.clipboard.write([new ClipboardItem({"image/png": Promise.resolve(img)})]); copiou=true; } }catch(e){ console.warn(e); }
    abrirWA(tel,legenda());
    mark("whatsEnviadoEm");
    pm.innerHTML = copiou
      ? "Imagem copiada. Na conversa que abriu, toque e segure na caixa de mensagem, escolha <b>Colar</b> e envie junto com o texto."
      : "Este aparelho não deixou copiar a imagem. Toque em <b>Compartilhar para o WhatsApp</b> de novo e escolha a conversa da cliente.";
  };
  // único botão: copia a foto da nota e abre direto a conversa da cliente com a mensagem escrita
  const copiarEAbrir=async()=>{
    const tel=telAtual();
    if(!waNumber(tel)){ toast("Informe o WhatsApp da cliente."); if(inp) inp.focus(); return; }
    let copiou=false;
    try{ if(navigator.clipboard && window.ClipboardItem){ await navigator.clipboard.write([new ClipboardItem({"image/png": Promise.resolve(img)})]); copiou=true; } }catch(e){ console.warn(e); }
    if(!copiou){
      // aparelho não deixa copiar imagem: usa o compartilhar (foto + mensagem juntas)
      if(podeArquivo() && await enviarCompartilhando()) return;
      try{ saveFile(img,img.name); }catch(e){}
    }
    abrirWA(tel,legenda());
    mark("whatsEnviadoEm");
    pm.innerHTML = copiou
      ? `Abrimos a conversa de <b>${esc(nomeCli)}</b> com a mensagem e a <b>foto da nota copiada</b>: toque e segure na caixa de mensagem, escolha <b>Colar</b> e envie.`
      : `Abrimos a conversa de <b>${esc(nomeCli)}</b>. A foto da nota foi salva no celular: toque no 📎, escolha a foto <b>${esc(img.name)}</b> e envie.`;
  };
  ib.onclick=async()=>{
    if(!img){ toast("A foto da nota ainda está sendo preparada. Tente de novo em instantes."); return; }
    await copiarEAbrir();
  };
  // ajusta textos quando a imagem fica pronta
  const ajustar=()=>{ if(!img) return;
    pm.innerHTML=`${o.whatsEnviadoEm?`Pedido enviado em ${fmtDate(o.whatsEnviadoEm)}. `:""}<b>Enviar nota pelo WhatsApp</b> abre direto a conversa de <b>${esc(nomeCli)}</b> com a mensagem pronta e a foto da nota copiada. Lá, toque e segure na caixa de mensagem, escolha <b>Colar</b> e envie.`; };
  const espera=setInterval(()=>{ if(img||!document.body.contains(ib)){ clearInterval(espera); ajustar(); } },200);
}
async function clienteImagem(o){
  if(!window.html2canvas) throw new Error("html2canvas");
  const box=document.createElement("div");
  box.className="force-light cli-render";
  box.innerHTML=notaHTML(o,{precos:true, qr:false});
  document.body.appendChild(box);
  try{
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const cv=await html2canvas(box.querySelector(".nota"),{scale:2,backgroundColor:"#ffffff",useCORS:true,logging:false});
    return await new Promise((res,rej)=>cv.toBlob(b=>b?res(b):rej(new Error("imagem")),"image/png"));
  } finally { box.remove(); }
}
async function notaImage(code,btn){
  const el=document.querySelector("#sheet .nota"); if(!el) return;
  if(!window.html2canvas){ toast("O gerador de imagem não carregou. Verifique a internet."); return; }
  const old=btn.textContent; btn.disabled=true; btn.innerHTML='<span class="busy"><span class="spin"></span>Preparando a nota</span>';
  const root=document.documentElement; const prevTheme=root.getAttribute("data-theme");
  try{
    root.setAttribute("data-theme","light");
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const canvas=await html2canvas(el,{scale:Math.min(3,Math.max(2,window.devicePixelRatio||2)),backgroundColor:"#ffffff",useCORS:true,logging:false});
    const url=canvas.toDataURL("image/png");
    ivBlob=await new Promise(r=>canvas.toBlob(r,"image/png")); ivCode=code;
    $("#iv-img").src=url; $("#imgview").hidden=false; $("#imgview").scrollTop=0;
    try{ const f=new File([ivBlob],`pedido-${code}.png`,{type:"image/png"}); $("#iv-share").hidden=!(navigator.canShare&&navigator.canShare({files:[f]})); }catch(e){ $("#iv-share").hidden=true; }
  }catch(e){ console.error(e); toast("Não consegui montar a imagem da nota. Tente de novo."); }
  finally{ if(prevTheme==null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme",prevTheme); btn.disabled=false; btn.textContent=old; }
}
$("#iv-share").addEventListener("click",async()=>{
  if(!ivBlob) return; const f=new File([ivBlob],`pedido-${ivCode}.png`,{type:"image/png"});
  try{ await navigator.share({files:[f], title:`Pedido ${ivCode}`}); }catch(e){ if(!(e&&e.name==="AbortError")) toast("Não deu para compartilhar. Salve a imagem e envie pelo WhatsApp."); }
});
$("#iv-close").addEventListener("click",()=>{ $("#imgview").hidden=true; $("#iv-img").removeAttribute("src"); });
$("#iv-save").addEventListener("click",async()=>{
  if(!ivBlob) return;
  try{ saveFile(ivBlob,`pedido-${ivCode}.png`); toast("Imagem baixada."); }
  catch(e){ toast("Não deu para baixar. Toque e segure na imagem da nota."); }
});

/* ---------- logística ---------- */
function isoDay(d){ const z=new Date(d); z.setMinutes(z.getMinutes()-z.getTimezoneOffset()); return z.toISOString().slice(0,10); }
function daysUntil(iso){ if(!iso) return null; const t=new Date(isoDay(new Date())+"T00:00:00"), e=new Date(iso+"T00:00:00"); return Math.round((e-t)/864e5); }
function lateTxt(o){
  if(!o.entrega) return "sem data";
  const d=daysUntil(o.entrega); if(o.status==="entregue"||o.status==="pronto") return "entrega "+fmtDay(o.entrega);
  if(d<0) return `<b style="color:var(--danger)">atrasado ${-d} dia${d<-1?"s":""}</b>`;
  if(d===0) return `<b style="color:var(--st-cos)">entrega hoje</b>`;
  if(d===1) return "entrega amanhã";
  return "entrega "+fmtDay(o.entrega);
}
function bucket(o){ const d=daysUntil(o.entrega); if(d===null) return "sem"; if(d<0) return "late"; if(d===0) return "today"; if(d===1) return "tom"; if(d<=7) return "week"; return "later"; }
/* ---------- valores do pedido ---------- */
const subOf=o=>Number(o.subtotal ?? o.total)||0;
const descOf=o=>Number(o.desconto)||0;
const totOf=o=>Number(o.total)||0;
const restOf=o=>Math.max(0,round2(totOf(o)-(Number(o.entrada)||0)));
function pagoNoAto(o){ return o.pagarEm==="ato" || (!o.pagarEm && o.pagamento!=="Pagar na retirada" && restOf(o)<=0.001 && Number(o.entrada)>0); }
function descLabel(o){ return o.descontoTipo==="pct" && o.descontoInformado ? `Desconto (${String(o.descontoInformado).replace(".",",")}%)` : "Desconto"; }

/* ---------- caixa do dia ---------- */
function cap(t){ t=String(t||""); return t.charAt(0).toUpperCase()+t.slice(1); }
function dayRange(iso){ const a=new Date(iso+"T00:00:00").getTime(); return [a, a+864e5]; }
function renderCaixa(){
  const body=$("#cx-body"); if(!body) return;
  const inp=$("#cx-dia"); if(!inp.value) inp.value=isoDay(new Date());
  const [a,b]=dayRange(inp.value); const inDay=t=>t>=a&&t<b;
  const feitos=orders.filter(o=>inDay(o.criadoEm||0));
  const entregues=orders.filter(o=>o.status==="entregue"&&inDay(deliveredAt(o)));
  const bruto=round2(feitos.reduce((x,o)=>x+subOf(o),0));
  const desc=round2(feitos.reduce((x,o)=>x+descOf(o),0));
  const liquido=round2(feitos.reduce((x,o)=>x+totOf(o),0));
  const formas={};
  const add=(f,v)=>{ if(!v) return; f=f||"Não informado"; formas[f]=round2((formas[f]||0)+v); };
  feitos.forEach(o=>{ if(o.pagamento!=="Pagar na retirada") add(o.pagamento,Number(o.entrada)||0); });
  entregues.forEach(o=>{ const v= o.valorRetirada!=null ? Number(o.valorRetirada)||0 : restOf(o); add(o.pagamentoRetirada,v); });
  const recebido=round2(Object.values(formas).reduce((x,v)=>x+v,0));
  const entradas=round2(feitos.reduce((x,o)=>x+(o.pagamento!=="Pagar na retirada"?(Number(o.entrada)||0):0),0));
  const naRetirada=round2(recebido-entradas);
  const aReceber=round2(feitos.filter(o=>o.status!=="entregue").reduce((x,o)=>x+restOf(o),0));
  const isToday=inp.value===isoDay(new Date());
  const dl=new Date(inp.value+"T12:00:00").toLocaleDateString("pt-BR",{weekday:"long",day:"2-digit",month:"long"});
  const formaRows=Object.entries(formas).sort((x,y)=>y[1]-x[1]).map(([f,v])=>`<tr><td>${esc(f)}</td><td class="n">${money(v)}</td></tr>`).join("");
  body.innerHTML=`
    <div class="cx-big"><span class="t">Recebido ${isToday?"hoje":"no dia"}</span><span class="n">${money(recebido)}</span><span class="s">${esc(cap(dl))}</span></div>
    <div class="hist-sum">
      <div class="stat"><span class="n">${feitos.length}</span><span class="t">Pedidos feitos</span></div>
      <div class="stat"><span class="n">${entregues.length}</span><span class="t">Pedidos entregues</span></div>
      <div class="stat"><span class="n">${money(aReceber)}</span><span class="t">A receber dos pedidos do dia</span></div>
    </div>
    <div class="panel"><span class="label">Recebido por forma de pagamento</span>
      ${formaRows?`<table class="cx-table">${formaRows}<tr class="tot"><td>Total recebido</td><td class="n">${money(recebido)}</td></tr></table>
      <p class="hint">Entradas dos pedidos feitos no dia: ${money(entradas)} · Pagamentos na retirada: ${money(naRetirada)}</p>`:`<p class="hint">Nenhum pagamento registrado neste dia.</p>`}
    </div>
    <div class="panel"><span class="label">Pedidos feitos no dia</span>
      <table class="cx-table">
        <tr><td>Valor dos serviços</td><td class="n">${money(bruto)}</td></tr>
        <tr class="minus"><td>Descontos dados</td><td class="n">− ${money(desc)}</td></tr>
        <tr class="tot"><td>Total vendido</td><td class="n">${money(liquido)}</td></tr>
      </table>
      ${feitos.length?`<div class="orders">${feitos.sort((x,y)=>y.criadoEm-x.criadoEm).map(o=>`<button class="ord${ordCls(o)}" data-open="${esc(o.codigo)}"><span class="stripe ${o.status}"></span>
        <span class="mid"><span class="code">${esc(o.codigo)}</span>${prioTag(o)}<span class="who">${esc(o.cliente?.nome)}</span>
        <span class="sub">${new Date(o.criadoEm).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})} · ${esc(o.pagamento||"")}${descOf(o)?" · desconto "+money(descOf(o)):""}</span></span>
        <span class="val">${money(totOf(o))}</span></button>`).join("")}</div>`:`<div class="empty">Nenhum pedido feito neste dia.</div>`}
    </div>`;
}
$("#cx-dia").addEventListener("change",renderCaixa);
$("#cx-hoje").addEventListener("click",()=>{ $("#cx-dia").value=isoDay(new Date()); renderCaixa(); });

/* ---------- faturamento mensal (gerência) ---------- */
function resumoPeriodo(a,b){
  const inR=t=>t>=a&&t<b;
  const feitos=orders.filter(o=>inR(o.criadoEm||0));
  const entregues=orders.filter(o=>o.status==="entregue"&&inR(deliveredAt(o)));
  const formas={}; const add=(f,v)=>{ if(!v) return; f=f||"Não informado"; formas[f]=round2((formas[f]||0)+v); };
  feitos.forEach(o=>{ if(o.pagamento!=="Pagar na retirada") add(o.pagamento,Number(o.entrada)||0); });
  entregues.forEach(o=>{ const v=o.valorRetirada!=null?Number(o.valorRetirada)||0:restOf(o); add(o.pagamentoRetirada,v); });
  const recebido=round2(Object.values(formas).reduce((x,v)=>x+v,0));
  return { feitos, entregues, formas, recebido,
    bruto:round2(feitos.reduce((x,o)=>x+subOf(o),0)), desc:round2(feitos.reduce((x,o)=>x+descOf(o),0)),
    vendido:round2(feitos.reduce((x,o)=>x+totOf(o),0)), aReceber:round2(feitos.filter(o=>o.status!=="entregue").reduce((x,o)=>x+restOf(o),0)) };
}
function mesRange(ym){ const [y,m]=ym.split("-").map(Number); return [new Date(y,m-1,1).getTime(), new Date(y,m,1).getTime()]; }
function mesNome(ym){ const [y,m]=ym.split("-").map(Number); return cap(new Date(y,m-1,15).toLocaleDateString("pt-BR",{month:"long",year:"numeric"})); }
function mesShift(ym,d){ const [y,m]=ym.split("-").map(Number); const t=new Date(y,m-1+d,1); return t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0"); }
/* ---------- despesas (só gerência) ---------- */
let despesas=[];
const DP_CATS=["Aluguel e condomínio","Água, luz e internet","Materiais e aviamentos","Salários e comissões","Manutenção de máquinas","Impostos e taxas","Transporte e entregas","Marketing","Outros"];
function despesasEntre(a,b){ return despesas.filter(d=>{ const t=new Date((d.data||"")+"T12:00:00").getTime(); return t>=a && t<b; }); }
function renderDespesas(){
  const body=$("#dp-body"); if(!body) return;
  const cat=$("#dp-cat"); if(!cat.options.length) cat.innerHTML=DP_CATS.map(c=>`<option>${esc(c)}</option>`).join("");
  if(!$("#dp-data").value) $("#dp-data").value=isoDay(new Date());
  const inp=$("#dp-mes"); if(!inp.value){ const n=new Date(); inp.value=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0"); }
  const ym=inp.value; const [a,b]=mesRange(ym);
  const l=despesasEntre(a,b).sort((x,y)=>(y.data||"").localeCompare(x.data||"")||(y.criadoEm||0)-(x.criadoEm||0));
  const tot=round2(l.reduce((s,d)=>s+(Number(d.valor)||0),0));
  const entrou=resumoPeriodo(a,b).recebido; const lucro=round2(entrou-tot);
  const porCat={}; l.forEach(d=>porCat[d.categoria||"Outros"]=(porCat[d.categoria||"Outros"]||0)+(Number(d.valor)||0));
  body.innerHTML=`
    <div class="hist-sum">
      <div class="stat"><span class="n" style="color:var(--danger)">${money(tot)}</span><span class="t">Despesas em ${esc(mesNome(ym).toLowerCase())}</span></div>
      <div class="stat"><span class="n">${money(entrou)}</span><span class="t">Entrou no mês</span></div>
      <div class="stat"><span class="n ${lucro>=0?"lucro-pos":"lucro-neg"}">${money(lucro)}</span><span class="t">Lucro (entrou − despesas)</span></div>
    </div>
    ${l.length?`<div class="panel"><span class="label">Por categoria</span><table class="cx-table">${Object.entries(porCat).sort((x,y)=>y[1]-x[1]).map(([c,v])=>`<tr><td>${esc(c)}</td><td class="n">${money(v)}</td></tr>`).join("")}<tr class="tot"><td>Total</td><td class="n">${money(tot)}</td></tr></table></div>`:""}
    <div class="panel"><span class="label">Lançamentos (${l.length})</span>
      ${l.length?l.map(d=>`<div class="dp-item"><div class="d"><b>${esc(d.descricao)}</b><span>${fmtDay(d.data)} · ${esc(d.categoria||"Outros")} · ${esc(d.forma||"")}${d.por?" · "+esc(d.por):""}</span></div><span class="v">${money(d.valor)}</span><button class="x" data-dp-del="${esc(d.id)}" aria-label="Apagar despesa ${esc(d.descricao)}">✕</button></div>`).join(""):`<p class="hint">Nenhuma despesa lançada neste mês.</p>`}
    </div>`;
}
$("#dp-add").addEventListener("click",async()=>{
  const desc=U($("#dp-desc").value.trim()), valor=round2(Number(String($("#dp-valor").value).replace(",","."))||0), data=$("#dp-data").value;
  if(!desc){ toast("Informe a descrição da despesa."); $("#dp-desc").focus(); return; }
  if(!(valor>0)){ toast("Informe o valor da despesa."); $("#dp-valor").focus(); return; }
  if(!data){ toast("Informe a data."); $("#dp-data").focus(); return; }
  const btn=$("#dp-add"); btn.disabled=true;
  const id="d"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  try{ await db.doc(`despesas/${id}`).set({descricao:desc, valor, data, categoria:$("#dp-cat").value, forma:$("#dp-forma").value, por:session?session.nome:"", criadoEm:Date.now()});
    $("#dp-desc").value=""; $("#dp-valor").value=""; $("#dp-mes").value=data.slice(0,7); toast("Despesa adicionada."); renderDespesas(); }
  catch(e){ writeErr(e); } finally{ btn.disabled=false; }
});
$("#dp-body").addEventListener("click",async e=>{ const b=e.target.closest("[data-dp-del]"); if(!b) return;
  const d=despesas.find(x=>x.id===b.dataset.dpDel); if(!d) return;
  if(b.dataset.ok!=="1"){ b.dataset.ok="1"; b.textContent="Apagar?"; b.style.color="var(--danger)"; setTimeout(()=>{ if(b.isConnected){ b.dataset.ok=""; b.textContent="✕"; b.style.color=""; } },4000); return; }
  try{ await db.doc(`despesas/${d.id}`).delete(); toast("Despesa apagada."); }catch(err){ writeErr(err); } });
$("#dp-mes").addEventListener("change",renderDespesas);
$("#dp-prev").addEventListener("click",()=>{ renderDespesas(); $("#dp-mes").value=mesShift($("#dp-mes").value,-1); renderDespesas(); });
$("#dp-next").addEventListener("click",()=>{ renderDespesas(); $("#dp-mes").value=mesShift($("#dp-mes").value,1); renderDespesas(); });

let ftModo="mes";
function fmtD(t){ return new Date(t).toLocaleDateString("pt-BR"); }
function renderFaturamento(){
  const body=$("#ft-body"); if(!body) return;
  let a,b,titulo,prevA,prevB,prevNome,ym=null;
  if(ftModo==="mes"){
    const inp=$("#ft-mes"); if(!inp.value){ const n=new Date(); inp.value=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0"); }
    ym=inp.value; [a,b]=mesRange(ym); titulo="Entrou em "+mesNome(ym).toLowerCase();
    [prevA,prevB]=mesRange(mesShift(ym,-1)); prevNome=mesNome(mesShift(ym,-1)).toLowerCase();
  } else {
    const de=$("#ft-de"), ate=$("#ft-ate");
    if(!de.value||!ate.value){ const t=new Date(); ate.value=ate.value||isoDay(t); const d=new Date(t); d.setDate(d.getDate()-29); de.value=de.value||isoDay(d); }
    if(de.value>ate.value){ body.innerHTML=`<div class="empty">A data inicial (De) precisa ser antes da data final (Até).</div>`; return; }
    a=new Date(de.value+"T00:00:00").getTime(); b=new Date(ate.value+"T00:00:00").getTime()+864e5;
    titulo=`Entrou de ${fmtD(a)} até ${fmtD(b-864e5)}`;
    prevB=a; prevA=a-(b-a); prevNome=`${fmtD(prevA)} a ${fmtD(prevB-864e5)}`;
  }
  const r=resumoPeriodo(a,b); const pr=resumoPeriodo(prevA,prevB);
  const dias=Math.round((b-a)/864e5);
  const dif = pr.recebido ? Math.round((r.recebido-pr.recebido)/pr.recebido*100) : null;
  const cmp = dif==null ? "Sem movimento no período anterior para comparar." : `${dif>=0?"▲":"▼"} ${Math.abs(dif)}% em relação a ${prevNome} (${money(pr.recebido)})`;
  // gráfico: por dia até 62 dias; por mês acima disso
  let bars="", xs="", rot="Entradas por dia";
  if(dias<=62){
    const porDia=[]; for(let i=0;i<dias;i++) porDia.push(resumoPeriodo(a+i*864e5, a+(i+1)*864e5).recebido);
    const maxD=Math.max(1,...porDia);
    bars=porDia.map((v,i)=>`<span class="b${v?"":" zero"}" style="height:${Math.round(v/maxD*100)}%" title="${fmtD(a+i*864e5)}: ${money(v)}"></span>`).join("");
    const passo = dias<=10?1 : dias<=31?5 : 10;
    xs=porDia.map((v,i)=>{ const d=new Date(a+i*864e5); return `<span>${(i===0||i===dias-1||(i%passo===0))?d.getDate()+(ym?"":"/"+(d.getMonth()+1)):""}</span>`; }).join("");
  } else {
    rot="Entradas por mês";
    const ini=new Date(a); let cur=ini.getFullYear()+"-"+String(ini.getMonth()+1).padStart(2,"0"); const fimYm=(()=>{ const f=new Date(b-1); return f.getFullYear()+"-"+String(f.getMonth()+1).padStart(2,"0"); })();
    const ms=[]; while(cur<=fimYm && ms.length<36){ const [ma,mb]=mesRange(cur); ms.push([cur, resumoPeriodo(Math.max(a,ma),Math.min(b,mb)).recebido]); cur=mesShift(cur,1); }
    const maxM=Math.max(1,...ms.map(x=>x[1]));
    bars=ms.map(([m,v])=>`<span class="b${v?"":" zero"}" style="height:${Math.round(v/maxM*100)}%" title="${esc(mesNome(m))}: ${money(v)}"></span>`).join("");
    xs=ms.map(([m])=>`<span>${m.slice(5)}/${m.slice(2,4)}</span>`).join("");
  }
  const formaRows=Object.entries(r.formas).sort((x,y)=>y[1]-x[1]).map(([f,v])=>`<tr><td>${esc(f)}</td><td class="n">${money(v)}</td></tr>`).join("");
  const ticket = r.feitos.length ? round2(r.vendido/r.feitos.length) : 0;
  let seis="";
  if(ftModo==="mes"){
    const meses=[]; for(let k=5;k>=0;k--){ const m=mesShift(ym,-k); meses.push([m, resumoPeriodo(...mesRange(m)).recebido]); }
    const maxM=Math.max(1,...meses.map(x=>x[1]));
    seis=`<div class="panel"><span class="label">Últimos 6 meses (o que entrou)</span><div class="hbars">${meses.map(([m,v])=>`<div class="hb${m===ym?" cur":""}"><span>${esc(cap(new Date(m+"-15T12:00:00").toLocaleDateString("pt-BR",{month:"short"})).replace(".",""))}/${m.slice(2,4)}</span><span class="tr"><i style="width:${Math.round(v/maxM*100)}%"></i></span><b>${money(v)}</b></div>`).join("")}</div></div>`;
  }
  const perTxt = ftModo==="mes" ? "no mês" : "no período";
  body.innerHTML=`
    <div class="cx-big"><span class="t">${esc(titulo)}</span><span class="n">${money(r.recebido)}</span><span class="ft-cmp">${esc(cmp)}</span></div>
    <div class="hist-sum">
      <div class="stat"><span class="n">${money(r.vendido)}</span><span class="t">Vendido ${perTxt}</span></div>
      <div class="stat"><span class="n">${r.feitos.length}</span><span class="t">Pedidos feitos</span></div>
      <div class="stat"><span class="n">${money(ticket)}</span><span class="t">Valor médio por pedido</span></div>
    </div>
    ${ftModo==="per"?`<p class="hint">${dias} dia${dias>1?"s":""} · média de ${money(round2(r.recebido/Math.max(1,dias)))} por dia.</p>`:""}
    <div class="panel"><span class="label">${rot}</span><div class="bars" role="img" aria-label="${rot}">${bars}</div><div class="bars-x">${xs}</div></div>
    <div class="panel"><span class="label">Recebido por forma de pagamento</span>
      ${formaRows?`<table class="cx-table">${formaRows}<tr class="tot"><td>Total que entrou</td><td class="n">${money(r.recebido)}</td></tr></table>`:`<p class="hint">Nenhum pagamento registrado ${perTxt}.</p>`}</div>
    <div class="panel"><span class="label">Vendas ${perTxt}</span>
      <table class="cx-table">
        <tr><td>Valor dos serviços</td><td class="n">${money(r.bruto)}</td></tr>
        <tr class="minus"><td style="color:var(--danger)">Descontos dados</td><td class="n" style="color:var(--danger)">− ${money(r.desc)}</td></tr>
        <tr class="tot"><td>Total vendido</td><td class="n">${money(r.vendido)}</td></tr>
        <tr><td>Pedidos entregues ${perTxt}</td><td class="n">${r.entregues.length}</td></tr>
        <tr><td>Ainda a receber dos pedidos ${perTxt==="no mês"?"do mês":"do período"}</td><td class="n">${money(r.aReceber)}</td></tr>
      </table></div>
    ${(()=>{ const dl=despesasEntre(a,b); const dt=round2(dl.reduce((x,d)=>x+(Number(d.valor)||0),0)); const lu=round2(r.recebido-dt);
      return `<div class="panel"><span class="label">Despesas e lucro ${perTxt}</span><table class="cx-table">
        <tr><td>Entrou</td><td class="n">${money(r.recebido)}</td></tr>
        <tr><td style="color:var(--danger)">Despesas (${dl.length})</td><td class="n" style="color:var(--danger)">− ${money(dt)}</td></tr>
        <tr class="tot"><td>Lucro</td><td class="n ${lu>=0?"lucro-pos":"lucro-neg"}">${money(lu)}</td></tr></table></div>`; })()}
    ${seis}
    <p class="hint">“Entrou” soma os pagamentos feitos no ato e os sinais (no dia do pedido) e os pagamentos na retirada ou na entrega (no dia em que o pedido foi entregue).</p>`;
}
function setFtModo(m){ ftModo=m; $("#ft-m-mes").setAttribute("aria-pressed",String(m==="mes")); $("#ft-m-per").setAttribute("aria-pressed",String(m==="per"));
  $("#ft-box-mes").hidden=m!=="mes"; $("#ft-box-per").hidden=m!=="per"; renderFaturamento(); }
$("#ft-m-mes").addEventListener("click",()=>setFtModo("mes"));
$("#ft-m-per").addEventListener("click",()=>setFtModo("per"));
$("#ft-de").addEventListener("change",renderFaturamento);
$("#ft-ate").addEventListener("change",renderFaturamento);
$("#ft-atalhos").addEventListener("click",e=>{ const c=e.target.closest("[data-r]"); if(!c) return; const t=new Date(); $("#ft-ate").value=isoDay(t);
  const d=new Date(t); if(c.dataset.r==="ano"){ d.setMonth(0,1); } else d.setDate(d.getDate()-(Number(c.dataset.r)-1)); $("#ft-de").value=isoDay(d); renderFaturamento(); });
$("#ft-mes").addEventListener("change",renderFaturamento);
$("#ft-prev").addEventListener("click",()=>{ if(!$("#ft-mes").value) renderFaturamento(); $("#ft-mes").value=mesShift($("#ft-mes").value,-1); renderFaturamento(); });
$("#ft-next").addEventListener("click",()=>{ if(!$("#ft-mes").value) renderFaturamento(); $("#ft-mes").value=mesShift($("#ft-mes").value,1); renderFaturamento(); });

/* ---------- entregues (histórico) ---------- */
let entPer="mes", entBusca="", entCost="";
function deliveredAt(o){
  if(o.entregueEm) return o.entregueEm;
  const h=(o.historico||[]).filter(x=>x.status==="entregue").pop();
  return h ? h.em : (o.criadoEm||0);
}
function deliveredBy(o){
  if(o.entreguePor) return o.entreguePor;
  const h=(o.historico||[]).filter(x=>x.status==="entregue").pop();
  return h ? h.por : "";
}
function norm(t){ return String(t||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }
function renderEntregues(){
  const box=$("#ent-list"); if(!box) return;
  const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const from = entPer==="hoje"?today : entPer==="7"?today-6*864e5 : entPer==="mes"?new Date(now.getFullYear(),now.getMonth(),1).getTime() : 0;
  const all=orders.filter(o=>o.status==="entregue");
  const costs=[...new Set(all.map(o=>o.costureira).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
  const sel=$("#ent-cost"); const cur=sel.value;
  sel.innerHTML=`<option value="">Todas</option>`+costs.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value=costs.includes(cur)?cur:""; entCost=sel.value;
  $("#ent-cost-box").hidden=!costs.length;
  const q=norm(entBusca).trim(); const qd=q.replace(/\D/g,"");
  let list=all.filter(o=>deliveredAt(o)>=from);
  if(entCost) list=list.filter(o=>o.costureira===entCost);
  if(q) list=list.filter(o=>{ const c=o.cliente||{};
    return norm(c.nome).includes(q) || norm(o.codigo).includes(q) || (qd.length>=3 && String(c.telefone||"").replace(/\D/g,"").includes(qd)); });
  list.sort((a,b)=>deliveredAt(b)-deliveredAt(a));
  const total=list.reduce((a,o)=>a+(Number(o.total)||0),0);
  const pecas=list.reduce((a,o)=>a+(o.itens||[]).reduce((x,i)=>x+(Number(i.qtd)||0),0),0);
  const perTxt={hoje:"hoje","7":"nos últimos 7 dias",mes:"neste mês",tudo:"no total"}[entPer];
  $("#ent-sum").innerHTML=`
    <div class="stat"><span class="n">${list.length}</span><span class="t">Pedidos entregues ${perTxt}</span></div>
    <div class="stat"><span class="n">${pecas}</span><span class="t">Serviços feitos</span></div>
    ${session&&session.papel==="costureira"?"":`<div class="stat"><span class="n">${money(total)}</span><span class="t">Valor dos pedidos</span></div>`}`;
  if(!list.length){
    box.innerHTML=`<div class="empty">${all.length? (q||entCost?"Nenhum pedido entregue encontrado com essa busca.":"Nenhum pedido entregue "+perTxt+". Toque em Tudo para ver os anteriores.") : "Quando a atendente marcar um pedido como entregue, ele aparece aqui."}</div>`;
    return;
  }
  const groups=new Map();
  list.forEach(o=>{ const d=new Date(deliveredAt(o)); const k=isoDay(d); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(o); });
  const yest=isoDay(new Date(today-864e5)), tod=isoDay(new Date(today));
  box.innerHTML=[...groups.entries()].map(([k,l])=>{
    const d=new Date(k+"T12:00:00");
    const lbl = k===tod?"Hoje" : k===yest?"Ontem" : cap(d.toLocaleDateString("pt-BR",{weekday:"long",day:"2-digit",month:"long"}));
    const sum=l.reduce((a,o)=>a+(Number(o.total)||0),0);
    return `<div class="day-group"><h4><span>${esc(lbl)}</span><span>${l.length}${session&&session.papel==="costureira"?"":" · "+money(sum)}</span></h4><div class="orders">${l.map(o=>{
      const qt=(o.itens||[]).reduce((a,b)=>a+b.qtd,0); const hr=new Date(deliveredAt(o)).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
      const by=deliveredBy(o);
      return `<button class="ord${ordCls(o)}" data-open="${esc(o.codigo)}"><span class="stripe entregue"></span>
        <span class="mid"><span class="code">${esc(o.codigo)}</span>${prioTag(o)}<span class="who">${esc(o.cliente?.nome)}</span>
        <span class="sub">${qt} serviço${qt>1?"s":""} · entregue às ${hr}${by?" por "+esc(by):""}${o.costureira?" · costura: "+esc(o.costureira):""}</span></span>
        ${session&&session.papel==="costureira"?"":`<span class="val">${money(o.total)}</span>`}</button>`; }).join("")}</div></div>`;
  }).join("");
}
$("#ent-periodo").addEventListener("click",e=>{ const b=e.target.closest("[data-per]"); if(!b) return; entPer=b.dataset.per;
  $("#ent-periodo").querySelectorAll("[data-per]").forEach(x=>x.setAttribute("aria-pressed",String(x===b))); renderEntregues(); });
let entT=null;
$("#ent-busca").addEventListener("input",e=>{ clearTimeout(entT); entT=setTimeout(()=>{ entBusca=e.target.value; if(entBusca.trim()&&entPer!=="tudo"){ entPer="tudo"; $("#ent-periodo").querySelectorAll("[data-per]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.per==="tudo"))); } renderEntregues(); },200); });
$("#ent-cost").addEventListener("change",e=>{ entCost=e.target.value; renderEntregues(); });

/* ---------- clientes ---------- */
let clOrdem="nome", clBusca="", clAberto="", clLimit=80, clEditando="";
function listaClientes(){
  const m=new Map();
  clientes.forEach((d,k)=>{ m.set(k,{k, nome:U(d.nome||""), telefone:d.telefone||"", endereco:d.endereco||"", ped:[]}); });
  orders.forEach(o=>{ const c=o.cliente||{}; const k=telKey(c.telefone)||("sem:"+norm(c.nome||"").trim()); if(k==="sem:") return;
    if(!m.has(k)) m.set(k,{k, nome:U(c.nome||""), telefone:c.telefone||"", endereco:"", ped:[]});
    const x=m.get(k); x.ped.push(o); if(!x.nome) x.nome=U(c.nome||""); if(!x.telefone) x.telefone=c.telefone||""; if(!x.endereco && o.endereco) x.endereco=o.endereco; });
  return [...m.values()].map(x=>{ x.ped.sort((a,b)=>(b.criadoEm||0)-(a.criadoEm||0)); x.ultimo=x.ped[0]?x.ped[0].criadoEm||0:0;
    x.abertos=x.ped.filter(o=>o.status!=="entregue"); x.gasto=round2(x.ped.reduce((a,o)=>a+(Number(o.total)||0),0)); x.deve=round2(x.abertos.reduce((a,o)=>a+restOf(o),0)); return x; });
}
function renderClientes(){
  const box=$("#cl-list"); if(!box) return;
  if(clEditando && $(".cli-ed")) return; // não apaga o que está sendo digitado
  const veValor=session&&session.papel!=="costureira";
  let l=listaClientes(); const total=l.length;
  const q=norm(clBusca).trim(), qd=q.replace(/\D/g,"");
  if(q) l=l.filter(x=>norm(x.nome).includes(q) || (qd.length>=3 && String(x.telefone).replace(/\D/g,"").includes(qd)) || (qd.length>=3 && x.k.includes(qd)));
  if(clOrdem==="abertos") l=l.filter(x=>x.abertos.length);
  const az=(a,b)=>a.nome.localeCompare(b.nome,"pt-BR");
  l.sort(clOrdem==="recente"?(a,b)=>b.ultimo-a.ultimo||az(a,b) : clOrdem==="pedidos"?(a,b)=>b.ped.length-a.ped.length||az(a,b) : az);
  $("#cl-count").textContent = q||clOrdem==="abertos" ? `${l.length} de ${total} cliente${total===1?"":"s"}` : `${total} cliente${total===1?"":"s"} cadastrada${total===1?"":"s"}`;
  if(!l.length){ box.innerHTML=`<div class="empty">${total?"Nenhuma cliente encontrada.":"As clientes aparecem aqui assim que o primeiro pedido for feito."}</div>`; return; }
  const vis=l.slice(0,clLimit);
  box.innerHTML=vis.map(x=>{ const ab=clAberto===x.k; const ini=(x.nome.trim()[0]||"?");
    return `<div class="cli${ab?" open":""}"><button class="cli-h" data-cli="${esc(x.k)}" aria-expanded="${ab}">
      <span class="av" aria-hidden="true">${esc(ini)}</span>
      <span class="mid"><span class="nm">${esc(x.nome||"SEM NOME")}</span><span class="sub">${esc(x.telefone||"sem telefone")}${x.ultimo?" · último pedido "+new Date(x.ultimo).toLocaleDateString("pt-BR"):""}</span></span>
      <span class="cnt${x.abertos.length?" ab":""}">${x.ped.length} pedido${x.ped.length===1?"":"s"}${x.abertos.length?`<br>${x.abertos.length} aberto${x.abertos.length===1?"":"s"}`:""}</span>
      <span class="chev" aria-hidden="true">›</span></button>
      ${ab?`<div class="cli-b">
        <dl class="info"><dt>Telefone</dt><dd>${esc(x.telefone||"—")}</dd>
          ${x.endereco?`<dt>Endereço</dt><dd>${esc(U(x.endereco))}</dd>`:""}
          <dt>Pedidos</dt><dd>${x.ped.length}${x.abertos.length?` (${x.abertos.length} em aberto)`:""}</dd>
          ${veValor&&x.ped.length?`<dt>Total gasto</dt><dd>${money(x.gasto)}</dd>`:""}
          ${veValor&&x.deve>0.001?`<dt>A receber</dt><dd style="color:var(--pay)">${money(x.deve)}</dd>`:""}</dl>
        ${clEditando===x.k?`<div class="cli-ed">
          <div class="field"><label for="ce-nome">Nome</label><input type="text" id="ce-nome" value="${esc(x.nome)}"></div>
          <div class="field"><label for="ce-tel">WhatsApp / telefone</label><input type="tel" id="ce-tel" value="${esc(x.telefone)}" placeholder="(81) 9 9999-9999"></div>
          <div class="field"><label for="ce-end">Endereço (opcional)</label><input type="text" id="ce-end" value="${esc(U(x.endereco||""))}"></div>
          <p class="hint">O nome e o telefone também são atualizados nos pedidos desta cliente.</p>
          <div class="acts"><button class="btn primary" data-cli-salvar="${esc(x.k)}">Salvar</button><button class="btn" data-cli-cancelar>Cancelar</button></div></div>`:""}
        <div class="acts">${clEditando!==x.k?`<button class="btn" data-cli-editar="${esc(x.k)}">Editar dados</button>`:""}${waNumber(x.telefone)?`<a class="btn wa" href="${waLink(x.telefone,"")}" ${ehCelular?"":'target="_blank" rel="noopener"'}>${waIcon}WhatsApp</a>`:""}
          ${VIEWS[session.papel].includes("atendimento")?`<button class="btn" data-cli-novo="${esc(x.k)}">Novo pedido</button>`:""}</div>
        ${x.ped.length?`<div class="orders">${x.ped.map(ordCard).join("")}</div>`:`<p class="hint">Nenhum pedido ainda.</p>`}
      </div>`:""}</div>`; }).join("")
    + (l.length>vis.length?`<button class="btn" id="cl-mais">Mostrar mais (${l.length-vis.length})</button>`:"");
  const mais=$("#cl-mais"); if(mais) mais.onclick=()=>{ clLimit+=80; renderClientes(); };
}
async function salvarClienteEditado(k,btn){
  const x=listaClientes().find(c=>c.k===k); if(!x) return;
  const nome=U($("#ce-nome").value.trim()), tel=$("#ce-tel").value.trim(), end=U($("#ce-end").value.trim());
  if(!nome){ toast("Informe o nome da cliente."); $("#ce-nome").focus(); return; }
  if(tel && !waNumber(tel)){ toast("Telefone inválido. Confira o número."); $("#ce-tel").focus(); return; }
  const nk=telKey(tel);
  btn.disabled=true; btn.textContent="Salvando…";
  try{
    if(nk){ await db.doc(`clientes/${nk}`).set({nome, telefone:tel, endereco:end, atualizadoEm:Date.now()}); }
    if(clientes.has(k) && k!==nk){ await db.doc(`clientes/${k}`).delete(); }
    // atualiza o nome/telefone nos pedidos dessa cliente
    const muda=x.ped.filter(o=>(o.cliente||{}).nome!==nome || String((o.cliente||{}).telefone||"")!==tel);
    for(const o of muda){ await db.doc(`pedidos/${o.codigo}`).update({cliente:{...(o.cliente||{}), nome, telefone:tel}}); }
    clEditando=""; clAberto=nk||("sem:"+norm(nome).trim());
    toast("Dados da cliente atualizados"+(muda.length?` em ${muda.length} pedido${muda.length>1?"s":""}.`:"."));
    renderClientes();
  }catch(e){ writeErr(e); btn.disabled=false; btn.textContent="Salvar"; }
}
$("#cl-list").addEventListener("click",e=>{
  const ed=e.target.closest("[data-cli-editar]"); if(ed){ clEditando=ed.dataset.cliEditar; renderClientes(); const i=$("#ce-nome"); if(i) i.focus(); return; }
  if(e.target.closest("[data-cli-cancelar]")){ clEditando=""; renderClientes(); return; }
  const sv=e.target.closest("[data-cli-salvar]"); if(sv){ salvarClienteEditado(sv.dataset.cliSalvar, sv); return; }
  const n=e.target.closest("[data-cli-novo]");
  if(n){ const x=listaClientes().find(c=>c.k===n.dataset.cliNovo); if(!x) return;
    setView("atendimento");
    const t=String(x.telefone||"").trim(); const d=t.replace(/\D/g,"");
    if(t.startsWith("+") && !t.startsWith("+55")){ $("#c-ddi").value="+"; $("#c-tel").value=t; }
    else { $("#c-ddi").value="+55"; $("#c-tel").value = t.startsWith("+55")? d.slice(2) : t; }
    $("#c-ddi").dispatchEvent(new Event("change"));
    $("#c-tel").dispatchEvent(new Event("input",{bubbles:true}));
    if(!$("#c-nome").value.trim()) $("#c-nome").value=x.nome;
    return; }
  const h=e.target.closest("[data-cli]"); if(!h) return;
  clAberto = clAberto===h.dataset.cli ? "" : h.dataset.cli; clEditando=""; renderClientes();
});
$("#cl-ordem").addEventListener("click",e=>{ const b=e.target.closest("[data-ord]"); if(!b) return; clOrdem=b.dataset.ord;
  $("#cl-ordem").querySelectorAll("[data-ord]").forEach(x=>x.setAttribute("aria-pressed",String(x===b))); renderClientes(); });
let clT=null;
$("#cl-busca").addEventListener("input",e=>{ clearTimeout(clT); clT=setTimeout(()=>{ clBusca=e.target.value; clLimit=80; renderClientes(); },200); });

/* ---------- entregar no dia ---------- */
function ddCard(o){
  const qt=(o.itens||[]).reduce((a,b)=>a+(b.qtd||0),0); const r=restOf(o);
  return `<button class="ord${ordCls(o)}" data-open="${esc(o.codigo)}"><span class="stripe ${o.status}"></span>
    <span class="mid"><span class="row" style="gap:8px"><span class="code">${esc(o.codigo)}</span>${prioTag(o)}${o.retornoDe||o.emRetorno?`<span class="tag-ret">RETORNO</span>`:""}${comEntrega(o)?`<span class="tag-ent">ENTREGA</span>`:""}${temOrc(o)&&!(session&&session.papel==="costureira")?`<span class="tag-orc">ORÇAMENTO</span>`:""}<span class="pill st-${o.status}" style="font-size:10px;padding:2px 7px">${STATUS[o.status]}</span></span>
    <span class="who">${esc(U((o.cliente||{}).nome||""))}</span>
    <span class="sub">${qt} serviço${qt>1?"s":""}${(o.cliente||{}).telefone?" · "+esc(o.cliente.telefone):""}${o.costureira?" · "+esc(o.costureira):""}</span>
    ${comEntrega(o)&&o.endereco?`<span class="sub" style="white-space:normal">${esc(o.endereco)}</span>`:""}</span>
    <span class="val">${r>0.001?`<span class="pay-l">a receber</span>${money(r)}`:`<span class="muted" style="font-size:11px">pago</span>`}</span></button>`;
}
let ddFiltro=null;
function renderDoDia(){
  const body=$("#dd-body"); if(!body) return;
  const inp=$("#dd-dia"); if(!inp.value) inp.value=isoDay(new Date());
  const dia=inp.value; const hoje=isoDay(new Date());
  const abertos=orders.filter(o=>o.status!=="entregue");
  const doDia=abertos.filter(o=>o.entrega===dia).sort((a,b)=>(a.status==="pronto"?0:1)-(b.status==="pronto"?0:1));
  const atrasados = dia===hoje ? abertos.filter(o=>o.entrega && o.entrega<dia).sort((a,b)=>a.entrega<b.entrega?-1:1) : [];
  const jaEntregues=orders.filter(o=>o.status==="entregue" && isoDay(new Date(deliveredAt(o)))===dia);
  const ent=doDia.filter(comEntrega), ret=doDia.filter(o=>!comEntrega(o));
  const naoProntos=doDia.filter(o=>o.status!=="pronto").length;
  const receber=round2(doDia.reduce((a,o)=>a+restOf(o),0));
  const dl=cap(new Date(dia+"T12:00:00").toLocaleDateString("pt-BR",{weekday:"long",day:"2-digit",month:"long"}));
  const grupo=(t,l,vazio)=>`<div class="panel"><span class="label">${t} (${l.length})</span>${l.length?`<div class="orders">${l.map(ddCard).join("")}</div>`:`<p class="hint">${vazio}</p>`}</div>`;
  body.innerHTML=`
    <div class="cx-big"><span class="t">${dia===hoje?"Para entregar hoje":"Para entregar em"}</span><span class="n">${doDia.length} pedido${doDia.length===1?"":"s"}</span><span class="s">${esc(dl)}</span></div>
    <div class="hist-sum">
      <button class="stat stat-btn" data-dd="entrega" aria-pressed="${ddFiltro==="entrega"}"><span class="n">${ent.length}</span><span class="t">Fazer entrega</span><span class="go">Ver ›</span></button>
      <button class="stat stat-btn" data-dd="retirada" aria-pressed="${ddFiltro==="retirada"}"><span class="n">${ret.length}</span><span class="t">Cliente vem buscar</span><span class="go">Ver ›</span></button>
      <button class="stat stat-btn" data-dd="naopronto" aria-pressed="${ddFiltro==="naopronto"}"><span class="n" style="${naoProntos?"color:var(--danger)":""}">${naoProntos}</span><span class="t">Ainda não prontos</span><span class="go">Ver ›</span></button>
    </div>
    ${ddFiltro?(()=>{ const m={entrega:["Fazer entrega no endereço",ent,"Nenhuma entrega marcada para este dia."], retirada:["Cliente vem buscar no ateliê",ret,"Nenhuma retirada marcada para este dia."], naopronto:["Ainda não prontos",doDia.filter(o=>o.status!=="pronto"),"Todos os pedidos do dia já estão prontos."]}[ddFiltro];
      return `<div class="panel" id="dd-filtro"><div class="row" style="justify-content:space-between"><span class="label">${m[0]} (${m[1].length})</span><button class="chip" id="dd-todos">Mostrar todos</button></div>${m[1].length?`<div class="orders">${m[1].map(ddCard).join("")}</div>`:`<p class="hint">${m[2]}</p>`}</div>`; })():`
    ${atrasados.length?`<div class="panel" style="border-color:var(--danger)"><span class="label" style="color:var(--danger)">Atrasados (${atrasados.length})</span><p class="hint">Pedidos com data anterior que ainda não foram entregues.</p><div class="orders">${atrasados.map(ddCard).join("")}</div></div>`:""}
    ${grupo("Fazer entrega no endereço",ent,"Nenhuma entrega marcada para este dia.")}
    ${grupo("Cliente vem buscar no ateliê",ret,"Nenhuma retirada marcada para este dia.")}
    `}
    ${doDia.length?`<p class="hint">A receber nestes pedidos: <b>${money(receber)}</b>.</p>`:""}
    ${jaEntregues.length?`<div class="panel"><span class="label">Já entregues neste dia (${jaEntregues.length})</span><div class="orders">${jaEntregues.map(ddCard).join("")}</div></div>`:""}`;
}
const ddShift=d=>{ const inp=$("#dd-dia"); if(!inp.value) inp.value=isoDay(new Date()); const t=new Date(inp.value+"T12:00:00"); t.setDate(t.getDate()+d); inp.value=isoDay(t); renderDoDia(); };
$("#dd-dia").addEventListener("change",renderDoDia);
$("#dd-body").addEventListener("click",e=>{
  const b=e.target.closest("[data-dd]");
  if(b){ ddFiltro = ddFiltro===b.dataset.dd ? null : b.dataset.dd; renderDoDia(); const f=$("#dd-filtro"); if(f) f.scrollIntoView({behavior:"smooth",block:"start"}); return; }
  if(e.target.closest("#dd-todos")){ ddFiltro=null; renderDoDia(); }
});
$("#dd-prev").addEventListener("click",()=>ddShift(-1));
$("#dd-next").addEventListener("click",()=>ddShift(1));
$("#dd-hoje").addEventListener("click",()=>{ $("#dd-dia").value=isoDay(new Date()); renderDoDia(); });

/* ---------- pedidos: pesquisa ---------- */
let pdSt="todos", pdPer="tudo", pdLimit=60;
function renderPedidos(){
  const box=$("#pd-list"); if(!box) return;
  const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const from = pdPer==="hoje"?today : pdPer==="7"?today-6*864e5 : pdPer==="mes"?new Date(now.getFullYear(),now.getMonth(),1).getTime() : 0;
  const raw=$("#pd-busca").value; const q=norm(raw).trim(); const qd=q.replace(/\D/g,"");
  let base=orders.filter(o=>(o.criadoEm||0)>=from);
  if(q) base=base.filter(o=>{ const c=o.cliente||{};
    return norm(c.nome).includes(q) || norm(o.codigo).includes(q) || norm(o.obs).includes(q)
      || (o.itens||[]).some(i=>norm(i.nome).includes(q)) || norm(o.costureira).includes(q) || norm(o.endereco).includes(q)
      || (qd.length>=3 && String(c.telefone||"").replace(/\D/g,"").includes(qd)); });
  const cnt={todos:base.length, recebido:0, em_costura:0, pronto:0, entregue:0, retorno:0};
  cnt.entrega=0; base.forEach(o=>{ cnt[o.status]=(cnt[o.status]||0)+1; if(o.retornoDe) cnt.retorno++; if(comEntrega(o)) cnt.entrega++; });
  $("#pd-status").querySelectorAll("[data-st]").forEach(b=>{ b.querySelector(".n").textContent=cnt[b.dataset.st]||0; });
  let list = pdSt==="todos"?base : pdSt==="retorno"?base.filter(o=>o.retornoDe) : pdSt==="entrega"?base.filter(comEntrega) : base.filter(o=>o.status===pdSt);
  list=[...list].sort((a,b)=>prioPrim(a,b)||(b.criadoEm||0)-(a.criadoEm||0));
  $("#pd-count").textContent = list.length ? `${list.length} pedido${list.length>1?"s":""} encontrado${list.length>1?"s":""}${list.length>pdLimit?`, mostrando os ${pdLimit} mais recentes`:""}.` : "";
  const verVal = session && session.papel!=="costureira";
  box.innerHTML = list.length ? list.slice(0,pdLimit).map(o=>{
    const qt=(o.itens||[]).reduce((a,b)=>a+(b.qtd||0),0);
    return `<button class="ord${ordCls(o)}" data-open="${esc(o.codigo)}"><span class="stripe ${o.status}"></span>
      <span class="mid"><span class="row" style="gap:8px"><span class="code">${esc(o.codigo)}</span>${prioTag(o)}${o.retornoDe||o.emRetorno?`<span class="tag-ret">RETORNO</span>`:""}${comEntrega(o)?`<span class="tag-ent">ENTREGA</span>`:""}${temOrc(o)&&!(session&&session.papel==="costureira")?`<span class="tag-orc">ORÇAMENTO</span>`:""}<span class="pill st-${o.status}" style="font-size:10px;padding:2px 7px">${STATUS[o.status]||o.status}</span></span>
      <span class="who">${esc(U((o.cliente||{}).nome||""))}</span>
      <span class="sub">${fmtDate(o.criadoEm).slice(0,10)} · ${qt} serviço${qt>1?"s":""}${(o.cliente||{}).telefone?" · "+esc(o.cliente.telefone):""}${o.costureira?" · "+esc(o.costureira):""}</span></span>
      ${verVal?`<span class="val">${o.status!=="entregue"&&restOf(o)>0.001?`<span class="pay-l">a receber</span>${money(restOf(o))}`:money(o.total)}</span>`:""}</button>`; }).join("")
    : `<div class="empty">${orders.length?"Nenhum pedido encontrado. Confira a pesquisa ou troque o filtro.":"Os pedidos feitos aparecem aqui."}</div>`;
  $("#pd-more").hidden = list.length<=pdLimit;
}
let pdT=null;
$("#pd-busca").addEventListener("input",()=>{ clearTimeout(pdT); pdT=setTimeout(()=>{ pdLimit=60; renderPedidos(); },150); });
$("#pd-status").addEventListener("click",e=>{ const b=e.target.closest("[data-st]"); if(!b) return; pdSt=b.dataset.st; pdLimit=60;
  $("#pd-status").querySelectorAll("[data-st]").forEach(x=>x.setAttribute("aria-pressed",String(x===b))); renderPedidos(); });
$("#pd-periodo").addEventListener("click",e=>{ const b=e.target.closest("[data-per]"); if(!b) return; pdPer=b.dataset.per; pdLimit=60;
  $("#pd-periodo").querySelectorAll("[data-per]").forEach(x=>x.setAttribute("aria-pressed",String(x===b))); renderPedidos(); });
$("#pd-more").addEventListener("click",()=>{ pdLimit+=60; renderPedidos(); });

/* ---------- costureiras (administração) ---------- */
let prPer="mes";
function doneAt(o){ const h=(o.historico||[]).filter(x=>x.status==="pronto" && !x.acao).pop(); return h ? h.em : (o.entregueEm || o.pegoEm || o.criadoEm || 0); }
function renderProducao(){
  const body=$("#pr-body"); if(!body) return;
  const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const from = prPer==="hoje"?today : prPer==="7"?today-6*864e5 : prPer==="mes"?new Date(now.getFullYear(),now.getMonth(),1).getTime() : 0;
  const perTxt={hoje:"hoje","7":"nos últimos 7 dias",mes:"neste mês",tudo:"no total"}[prPer];
  const nomes=[...new Set([...team.filter(m=>m.papel==="costureira").map(m=>m.nome), ...orders.filter(o=>o.costureira).map(o=>o.costureira)])]
    .sort((a,b)=>String(a).localeCompare(String(b),"pt-BR"));
  const fila=orders.filter(o=>o.status==="recebido");
  const fazendoTot=orders.filter(o=>o.status==="em_costura").length;
  const resumo=`<div class="hist-sum">
    <div class="stat"><span class="n">${fila.length}</span><span class="t">Esperando costureira</span></div>
    <div class="stat"><span class="n">${fazendoTot}</span><span class="t">Sendo feitos agora</span></div>
    <div class="stat"><span class="n">${orders.filter(o=>o.costureira&&(o.status==="pronto"||o.status==="entregue")&&doneAt(o)>=from).length}</span><span class="t">Feitos ${perTxt}</span></div></div>`;
  if(!nomes.length){ body.innerHTML=resumo+`<div class="empty">Cadastre as costureiras na aba Equipe para acompanhar o trabalho delas aqui.</div>`; return; }
  const item=o=>`<button class="cs-item" data-open="${esc(o.codigo)}"><b>${esc(U((o.cliente||{}).nome||"Cliente"))}</b><span>${esc(o.codigo)}${o.entrega?" · "+fmtDay(o.entrega).slice(0,5):""}</span></button>`;
  body.innerHTML=resumo+`<span class="label cs-sec">Por costureira</span><div class="cs-grid">${nomes.map(n=>{
    const fazendo=orders.filter(o=>o.status==="em_costura" && o.costureira===n).sort((a,b)=>(a.entrega||"9")<(b.entrega||"9")?-1:1);
    const feitos=orders.filter(o=>o.costureira===n && (o.status==="pronto"||o.status==="entregue") && doneAt(o)>=from);
    return `<div class="cs"><div class="cs-hd"><span class="av">${esc(initials(n))}</span><b>${esc(n)}</b></div>
      <div class="cs-nums"><div><span class="n done">${feitos.length}</span><span class="t">Pedidos feitos ${perTxt}</span></div><div><span class="n doing">${fazendo.length}</span><span class="t">Fazendo agora</span></div></div>
      ${fazendo.length?`<div class="cs-list"><span class="label">Está fazendo os pedidos de</span>${fazendo.map(item).join("")}</div>`:`<p class="hint">Sem pedido em costura agora.</p>`}
    </div>`; }).join("")}</div>`;
}
$("#pr-periodo").addEventListener("click",e=>{ const b=e.target.closest("[data-per]"); if(!b) return; prPer=b.dataset.per;
  $("#pr-periodo").querySelectorAll("[data-per]").forEach(x=>x.setAttribute("aria-pressed",String(x===b))); renderProducao(); });

function renderLogi(){
  if(!$("#lg-tiles")) return;
  const prod=orders.filter(o=>o.status==="recebido"||o.status==="em_costura")
    .sort((a,b)=>(a.entrega||"9999")<(b.entrega||"9999")?-1:(a.entrega||"9999")>(b.entrega||"9999")?1:a.criadoEm-b.criadoEm);
  const prontos=orders.filter(o=>o.status==="pronto");
  const cnt=k=>prod.filter(o=>bucket(o)===k).length;
  $("#lg-tiles").innerHTML=`
    <button class="tile late" data-jump="late"><span class="n">${cnt("late")}</span><span class="t">Atrasados</span></button>
    <button class="tile today" data-jump="today"><span class="n">${cnt("today")}</span><span class="t">Para hoje</span></button>
    <button class="tile tom" data-jump="tom"><span class="n">${cnt("tom")}</span><span class="t">Para amanhã</span></button>
    <button class="tile ready" data-jump="ready"><span class="n">${prontos.length}</span><span class="t">Prontos p/ retirar</span></button>`;
  const groups=[["late","Atrasados"],["today","Hoje"],["tom","Amanhã"],["week","Próximos 7 dias"],["later","Mais adiante"],["sem","Sem data de entrega"]];
  const gh=groups.map(([k,t])=>{ const l=prod.filter(o=>bucket(o)===k); if(!l.length) return "";
    return `<div class="lg-group" id="lg-${k}"><h4 class="${k==="late"?"late":""}"><span>${t}</span><span>${l.length}</span></h4><div class="orders">${l.map(ordCard).join("")}</div></div>`; }).join("");
  $("#lg-prazos").innerHTML = gh || `<div class="empty">Nenhuma peça na produção agora.</div>`;
  const names=[...new Set([...team.filter(m=>m.papel==="costureira").map(m=>m.nome), ...prod.filter(o=>o.costureira&&o.status==="em_costura").map(o=>o.costureira)])];
  const livre=prod.filter(o=>o.status==="recebido");
  const chip=o=>`<button data-open="${esc(o.codigo)}" class="${bucket(o)==="late"?"late":""}">${esc(o.codigo)} · ${o.entrega?fmtDay(o.entrega).slice(0,5):"s/ data"}</button>`;
  const people=names.map(n=>{ const l=prod.filter(o=>o.status==="em_costura"&&o.costureira===n); const late=l.filter(o=>bucket(o)==="late").length;
    return `<div class="person"><div class="hd"><b>${esc(n)}</b><span class="muted" style="font-size:13px">${l.length} em costura${late?` · <b style="color:var(--danger)">${late} atrasado${late>1?"s":""}</b>`:""}</span></div>${l.length?`<div class="mini">${l.map(chip).join("")}</div>`:`<span class="hint">Livre para pegar pedido.</span>`}</div>`; }).join("");
  $("#lg-pessoas").innerHTML = `${livre.length?`<div class="person"><div class="hd"><b>Ninguém pegou ainda</b><span class="muted" style="font-size:13px">${livre.length} na fila</span></div><div class="mini">${livre.map(chip).join("")}</div></div>`:""}${people}` || `<div class="empty">Cadastre as costureiras na aba Equipe.</div>`;
  $("#lg-prontos").innerHTML = prontos.length ? `<div class="orders" id="lg-ready">${prontos.map(ordCard).join("")}</div>` : `<div class="empty" id="lg-ready">Nenhuma peça pronta esperando a cliente.</div>`;
  const locs=[...new Set(orders.map(o=>o.local).filter(Boolean))].slice(0,30);
  $("#locais").innerHTML=locs.map(l=>`<option value="${esc(l)}"></option>`).join("");
}
$("#lg-tiles").addEventListener("click",e=>{ const b=e.target.closest("[data-jump]"); if(!b) return; const t=document.getElementById("lg-"+b.dataset.jump); if(t) t.scrollIntoView({behavior:"smooth",block:"start"}); else toast("Nada nesta lista."); });

/* ---------- nota / detalhe ---------- */
function qrText(code){ return code; }
async function openOrder(code, given){
  code=String(code||"").trim().toUpperCase();
  if(!/^CE-[A-Z0-9]{6}$/.test(code)){toast("Código inválido. Ele começa com CE-."); return;}
  let o = given || orders.find(x=>x.codigo===code);
  if(!o && db){ try{ const s=await db.doc(`pedidos/${code}`).get(); if(s.exists) o=s.data(); }catch(e){} }
  if(!o){toast("Pedido "+code+" não encontrado."); return;}
  openCode=code; renderSheet(o); $("#overlay").hidden=false; document.body.style.overflow="hidden";
  $("#overlay").scrollTop=0;
}
function closeSheet(){ editing=null; if(!$("#overlay")) return; $("#overlay").hidden=true; openCode=null; if(takePhoto){URL.revokeObjectURL(takePhoto.url); takePhoto=null;} document.body.style.overflow=""; }
$("#overlay").addEventListener("click",e=>{ if(e.target.id==="overlay") closeSheet(); });
document.addEventListener("keydown",e=>{ if(e.key==="Escape" && !$("#overlay").hidden) closeSheet(); });

function diaAntes(iso){ if(!iso) return ""; const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()-1); if(d.getDay()===0) d.setDate(d.getDate()-1); return isoDay(d); }
function notaHTML(o,{precos=true,qr=true,interna=false}={}){
  const c=o.cliente||{}; const restante=restOf(o);
  const rows=(o.itens||[]).map(i=>`<tr><td>${esc(i.nome)}${i.orcamento?` <span class="aorcar">· EM ORÇAMENTO</span>`:""}</td><td class="n">${i.qtd}×</td>${precos?(i.orcamento?`<td class="n aorcar" colspan="2">A ORÇAR</td>`:`<td class="n">${money(i.preco)}</td><td class="n">${money(i.preco*i.qtd)}</td>`):""}</tr>`).join("");
  return `
    <article class="nota" aria-label="Pedido ${esc(o.codigo)}">
      <div class="nota-head">
        <div><span class="logo" role="img" aria-label="Costura Expressa"></span><div class="addr">Galeria Jaqueira Park Center<br>R. do Futuro, 913 · Graças · Recife/PE</div></div>
        <div class="meta">Nº<b>${esc(o.codigo)}</b>${fmtDate(o.criadoEm)}</div>
      </div>
      ${qr&&ehPrio(o)?`<div class="prio-nota">★ PRIORIDADE</div>`:""}
      <dl class="kv">
        ${o.retornoDe?`<dt>Retorno do</dt><dd>Pedido ${esc(o.retornoDe)}</dd>`:""}
        ${(o.retornos||[]).length?`<dt>Retornos</dt><dd>${o.retornos.map(esc).join(", ")}</dd>`:""}
        <dt>Cliente</dt><dd>${esc(c.nome)}</dd>
        ${c.telefone?`<dt>Telefone</dt><dd>${esc(c.telefone)}</dd>`:""}
        <dt>${comEntrega(o)?"Data da entrega":"Retirada prevista"}</dt><dd>${fmtDay(interna?diaAntes(o.entrega):o.entrega)}</dd>
        <dt>Entrega</dt><dd>${comEntrega(o)?"FAZER ENTREGA":"CLIENTE RETIRA NO ATELIÊ"}</dd>
        ${comEntrega(o)&&o.endereco?`<dt>Endereço</dt><dd>${esc(o.endereco)}</dd>`:""}
        ${o.atendente?`<dt>Atendente</dt><dd>${esc(o.atendente)}</dd>`:""}
        ${o.costureira?`<dt>Costureira</dt><dd>${esc(o.costureira)}</dd>`:""}
      </dl>
      <div style="overflow-x:auto"><table class="items">
        <thead><tr><th>Serviço</th><th class="n">Qtd</th>${precos?`<th class="n">Unit.</th><th class="n">Valor</th>`:""}</tr></thead>
        <tbody>${rows}</tbody>
        ${precos?`<tfoot>
          ${descOf(o)?`<tr><td colspan="3">Subtotal</td><td class="n">${money(subOf(o))}</td></tr><tr class="disc"><td colspan="3">${descLabel(o)}</td><td class="n">− ${money(descOf(o))}</td></tr>`:""}
          <tr><td colspan="3">Total</td><td class="n big">${money(o.total)}</td></tr>
          ${pagoNoAto(o) ? `<tr><td colspan="3" class="muted" style="font-weight:500">Pago no ato (${esc(o.pagamento)})</td><td class="n" style="font-weight:500">${money(o.entrada)}</td></tr>`
            : `${Number(o.entrada)?`<tr><td colspan="3" class="muted" style="font-weight:500">Sinal (${esc(o.pagamento)})</td><td class="n" style="font-weight:500">${money(o.entrada)}</td></tr>`:""}
               ${o.status==="entregue"&&o.valorRetirada?`<tr><td colspan="3" class="muted" style="font-weight:500">Pago na retirada (${esc(o.pagamentoRetirada||"")})</td><td class="n" style="font-weight:500">${money(o.valorRetirada)}</td></tr><tr><td colspan="3">Situação</td><td class="n">Quitado</td></tr>`
                 : restante>0.001?`<tr class="pay"><td colspan="3">A pagar ${ondePaga(o)}</td><td class="n">${money(restante)}</td></tr>`:""}`}
        </tfoot>`:""}
      </table></div>
      ${o.obs?`<div><div class="label" style="margin-bottom:6px">Observações</div><div class="obs">${esc(o.obs)}</div></div>`:""}
      ${qr?`<div class="qr-area"><div class="qr" id="qr"></div><div><div class="label">Código do pedido</div><div class="cd">${esc(o.codigo)}</div><p class="hint" style="margin-top:6px">Apresente este pedido para retirar a peça.</p></div></div>`:`<div class="cli-code"><span class="label">Código do pedido</span><b>${esc(o.codigo)}</b><span>Apresente este código para retirar a peça.</span></div>`}
      <div class="foot">WhatsApp (81) 99616-0055${qr?`<small>Comprovante interno do ateliê · sem valor fiscal</small>`:""}</div>
    </article>`;
}
let editing=null;
function renderEdit(o){
  const c=o.cliente||{};
  const e={ itens:(o.itens||[]).map(i=>({nome:U(i.nome), preco:Number(i.preco)||0, qtd:Number(i.qtd)||1, orcamento:!!i.orcamento})),
    tipo:o.descontoTipo==="pct"?"pct":"valor", desc: o.descontoTipo==="pct" ? (Number(o.descontoInformado)||0) : (Number(o.desconto)||0) };
  editing=o.codigo;
  const pagOpts=["Pix","Dinheiro","Cartão de débito","Cartão de crédito","Pagar na retirada"];
  $("#sheet").innerHTML=`
    <div class="sheet-top"><span class="pill st-${o.status}">Editando ${esc(o.codigo)}</span><button class="btn" id="ed-cancel-top">Cancelar</button></div>
    <div class="panel"><span class="label">Cliente</span>
      <div class="field"><label for="ed-nome">Nome</label><input type="text" id="ed-nome" value="${esc(U(c.nome))}"></div>
      <div class="field"><label for="ed-tel">Telefone / WhatsApp</label><input type="tel" id="ed-tel" value="${esc(c.telefone||"")}"></div>
      <div class="field"><label for="ed-entrega">Data prevista</label><input type="date" id="ed-entrega" value="${esc(o.entrega||"")}"></div>
      <div class="field"><span class="flabel">Precisa fazer entrega?</span>
        <div class="paywhen" role="group"><button type="button" id="ed-et-ret" aria-pressed="${!comEntrega(o)}">Não, a cliente vem buscar</button><button type="button" id="ed-et-ent" aria-pressed="${comEntrega(o)}">Sim, fazer entrega</button></div></div>
      <div class="field" id="ed-f-end" ${comEntrega(o)?"":"hidden"}><label for="ed-end">Endereço de entrega</label><textarea id="ed-end" rows="2">${esc(U(o.endereco||""))}</textarea></div>
    </div>
    <div class="panel"><span class="label">Serviços</span>
      <div class="edit-items" id="ed-items"></div>
      <div class="edit-add"><select id="ed-add-sel" aria-label="Adicionar serviço da tabela"><option value="">ADICIONAR SERVIÇO DA TABELA…</option>${services.map(s=>`<option value="${s.id}">${esc(U(s.nome))} · ${money(s.preco)}</option>`).join("")}</select><button class="btn" id="ed-add" type="button">Adicionar</button></div>
      <div class="av-row"><input type="text" id="ed-av-nome" placeholder="SERVIÇO FORA DA TABELA" aria-label="Serviço fora da tabela"><input type="number" id="ed-av-preco" min="0" step="0.01" inputmode="decimal" placeholder="R$ 0,00" aria-label="Valor"><button class="btn" id="ed-av-add" type="button">Adicionar</button></div>
    </div>
    <div class="panel"><span class="label">Pagamento</span>
      <div class="field desc-field"><label for="ed-desc">Desconto</label>
        <div class="desc-row"><div class="seg" role="group" aria-label="Tipo de desconto"><button type="button" id="ed-dt-valor">R$</button><button type="button" id="ed-dt-pct">%</button></div>
        <input type="number" id="ed-desc" min="0" step="0.01" inputmode="decimal" value="${e.desc||""}" placeholder="0"></div></div>
      <div class="grid2">
        <div class="field"><label for="ed-pag">Forma de pagamento da entrada</label><select id="ed-pag">${pagOpts.map(x=>`<option${x===o.pagamento?" selected":""}>${x}</option>`).join("")}</select></div>
        <div class="field"><label for="ed-entrada">Valor de entrada (R$)</label><input type="number" id="ed-entrada" min="0" step="0.01" inputmode="decimal" value="${Number(o.entrada)||""}"></div>
      </div>
      <div class="sumbox" id="ed-sum"></div>
    </div>
    <div class="panel"><span class="label">Observações</span><textarea id="ed-obs">${esc(U(o.obs||""))}</textarea></div>
    ${(o.status==="entregue"||o.status==="pronto") && !o.retornoDe ? `<div class="panel ret-box"><span class="label">Retorno</span>
      <p class="hint">A cliente voltou para refazer algum ajuste? Este pedido fica guardado e um pedido de retorno vai para a fila das costureiras.</p>
      <button class="btn" type="button" id="ed-retorno">Este pedido vai ter retorno</button></div>`
      : !o.retornoDe ? `<div class="panel"><span class="label">Retorno</span><p class="hint">O retorno fica disponível quando o pedido estiver pronto.</p></div>` : ""}
    <div class="edit-bar"><button class="btn ghost" id="ed-cancel">Cancelar</button><button class="btn primary" id="ed-save">Salvar alterações</button></div>`;
  $("#overlay").scrollTop=0;
  const calc=()=>{
    const sub=round2(e.itens.reduce((a,i)=>a+i.preco*i.qtd,0));
    const raw=Math.max(0,Number($("#ed-desc").value)||0);
    let desc=0, err="";
    if(e.tipo==="pct"){ if(raw>100) err="O desconto não pode passar de 100%."; else desc=round2(sub*raw/100); }
    else { if(raw>sub) err="O desconto é maior que o valor dos serviços."; else desc=round2(raw); }
    const tot=round2(sub-desc); const ent=Math.max(0,Number($("#ed-entrada").value)||0);
    if(!err && ent>tot+0.001) err="A entrada é maior que o total do pedido.";
    if(!err && !e.itens.length) err="O pedido precisa ter pelo menos um serviço.";
    return {sub,raw,desc,tot,ent,err};
  };
  const paint=()=>{
    $("#ed-items").innerHTML = e.itens.length ? e.itens.map((i,k)=>`<div class="ei"><span class="nm">${esc(i.nome)}${i.orcamento?` <span class="aorcar">· A ORÇAR: digite o valor</span>`:""}</span>
      <input type="number" min="0" step="0.01" inputmode="decimal" data-ep="${k}" value="${i.orcamento?"":i.preco.toFixed(2)}" placeholder="a orçar" aria-label="Valor de ${esc(i.nome)}">
      <div class="step"><button type="button" data-edec="${k}" aria-label="Diminuir">−</button><span class="q">${i.qtd}</span><button type="button" data-einc="${k}" aria-label="Aumentar">+</button></div>
      <button type="button" class="x" data-erm="${k}" aria-label="Remover ${esc(i.nome)}">×</button></div>`).join("") : `<div class="empty">Nenhum serviço. Adicione abaixo.</div>`;
    $("#ed-dt-valor").setAttribute("aria-pressed",String(e.tipo==="valor")); $("#ed-dt-pct").setAttribute("aria-pressed",String(e.tipo==="pct"));
    sum();
  };
  const sum=()=>{ const r=calc();
    $("#ed-sum").innerHTML=`<div><span>Serviços</span><span>${money(r.sub)}</span></div>${r.desc?`<div class="disc"><span>Desconto${e.tipo==="pct"?" ("+String(r.raw).replace(".",",")+"%)":""}</span><span>− ${money(r.desc)}</span></div>`:""}
      <div class="tot"><span>Total</span><span>${money(r.tot)}</span></div><div><span>A receber na retirada</span><span>${money(Math.max(0,r.tot-r.ent))}</span></div>${r.err?`<div class="err">${r.err}</div>`:""}`; };
  $("#ed-items").addEventListener("click",ev=>{
    const a=ev.target.closest("[data-einc]"), d=ev.target.closest("[data-edec]"), x=ev.target.closest("[data-erm]");
    if(a) e.itens[+a.dataset.einc].qtd++;
    if(d){ const it=e.itens[+d.dataset.edec]; it.qtd=Math.max(1,it.qtd-1); }
    if(x) e.itens.splice(+x.dataset.erm,1);
    if(a||d||x) paint();
  });
  $("#ed-items").addEventListener("input",ev=>{ const k=ev.target.dataset.ep; if(k==null) return; e.itens[+k].preco=round2(Math.max(0,Number(ev.target.value)||0)); if(e.itens[+k].preco>0) e.itens[+k].orcamento=false; sum(); });
  $("#ed-add").onclick=()=>{ const sv=services.find(x=>x.id===$("#ed-add-sel").value); if(!sv){ toast("Escolha um serviço da tabela."); return; }
    const ex=e.itens.find(i=>i.nome===U(sv.nome) && i.preco===Number(sv.preco)); if(ex) ex.qtd++; else e.itens.push({nome:U(sv.nome), preco:Number(sv.preco)||0, qtd:1});
    $("#ed-add-sel").value=""; paint(); };
  $("#ed-av-add").onclick=()=>{ const n=U($("#ed-av-nome").value.trim()), v=Number($("#ed-av-preco").value);
    if(!n){ toast("Descreva o serviço."); return; } if($("#ed-av-preco").value===""||!(v>=0)){ toast("Informe o valor do serviço."); return; }
    e.itens.push({nome:n, preco:round2(v), qtd:1}); $("#ed-av-nome").value=""; $("#ed-av-preco").value=""; paint(); };
  $("#ed-dt-valor").onclick=()=>{ e.tipo="valor"; paint(); };
  $("#ed-dt-pct").onclick=()=>{ e.tipo="pct"; paint(); };
  ["#ed-desc","#ed-entrada"].forEach(q=>$(q).addEventListener("input",sum));
  const sair=()=>{ editing=null; const cur=orders.find(x=>x.codigo===o.codigo)||o; renderSheet(cur); $("#overlay").scrollTop=0; };
  $("#ed-cancel").onclick=sair; $("#ed-cancel-top").onclick=sair;
  let edEt=comEntrega(o)?"entrega":"retirada";
  const setEdEt=v=>{ edEt=v; $("#ed-et-ret").setAttribute("aria-pressed",String(v==="retirada")); $("#ed-et-ent").setAttribute("aria-pressed",String(v==="entrega")); $("#ed-f-end").hidden=v!=="entrega"; };
  $("#ed-et-ret").onclick=()=>setEdEt("retirada"); $("#ed-et-ent").onclick=()=>setEdEt("entrega");
  const er=$("#ed-retorno"); if(er) er.onclick=()=>{ editing=null; renderRetorno(orders.find(x=>x.codigo===o.codigo)||o); };
  $("#ed-save").onclick=async()=>{
    const r=calc(); if(r.err){ toast(r.err); return; }
    const nome=U($("#ed-nome").value.trim()); if(!nome){ toast("Informe o nome da cliente."); $("#ed-nome").focus(); return; }
    if(edEt==="entrega" && !$("#ed-end").value.trim()){ toast("Informe o endereço de entrega."); $("#ed-end").focus(); return; }
    const btn=$("#ed-save"); btn.disabled=true; btn.textContent="Salvando…";
    const cur=orders.find(x=>x.codigo===o.codigo)||o; const now=Date.now();
    const patch={ cliente:{...(cur.cliente||{}), nome, telefone:$("#ed-tel").value.trim()}, entrega:$("#ed-entrega").value||"", entregaTipo:edEt, endereco: edEt==="entrega"?U($("#ed-end").value.trim()):"",
      itens:e.itens.map(i=>({nome:i.nome, preco:i.preco, qtd:i.qtd, ...(i.orcamento?{orcamento:true}:{})})), subtotal:r.sub, desconto:r.desc, descontoTipo:e.tipo, descontoInformado:r.raw,
      total:r.tot, entrada:round2(r.ent), pagamento:$("#ed-pag").value, obs:U($("#ed-obs").value.trim()),
      pagarEm: ($("#ed-pag").value!=="Pagar na retirada" && r.ent>=r.tot-0.001 && r.tot>0) ? "ato" : "retirada",
      editadoEm:now, editadoPor:session?session.nome:"",
      historico:[...(cur.historico||[]),{status:cur.status, acao:"Pedido editado", por:session?session.nome:"", em:now}] };
    if(cur.status==="entregue"){ patch.valorRetirada=Math.max(0,round2(r.tot-r.ent)); }
    try{ await db.doc(`pedidos/${o.codigo}`).update(patch); editing=null; toast(`Pedido ${o.codigo} atualizado.`); saveCliente(patch.cliente.nome, patch.cliente.telefone, patch.endereco);
      renderSheet({...cur, ...patch}); $("#overlay").scrollTop=0; }
    catch(err){ writeErr(err); btn.disabled=false; btn.textContent="Salvar alterações"; }
  };
  paint();
}
function renderRetorno(o){
  editing=o.codigo;
  const c=o.cliente||{};
  $("#sheet").innerHTML=`
    <div class="sheet-top"><span class="pill st-${o.status}">Retorno de ${esc(o.codigo)}</span><button class="btn" id="rt-cancel-top">Cancelar</button></div>
    <div class="panel"><span class="label">Cliente</span><b style="text-transform:uppercase">${esc(c.nome||"")}</b>${c.telefone?`<span class="muted">${esc(c.telefone)}</span>`:""}</div>
    <div class="panel"><span class="label">O que precisa refazer</span>
      <div class="ret-items">${(o.itens||[]).map((i,k)=>`<label><input type="checkbox" data-ri="${k}" checked> ${esc(U(i.nome))}${i.qtd>1?` (${i.qtd}×)`:""}</label>`).join("")}</div>
      <div class="field"><label for="rt-motivo">Motivo do retorno</label><textarea id="rt-motivo" placeholder="EX.: BARRA FICOU CURTA, APERTAR MAIS A CINTURA"></textarea></div>
    </div>
    <div class="panel"><span class="label">Entrega e valor</span>
      <div class="grid2">
        <div class="field"><label for="rt-entrega">Nova entrega prevista</label><input type="date" id="rt-entrega"></div>
        <div class="field"><label for="rt-valor">Cobrar pelo retorno (R$)</label><input type="number" id="rt-valor" min="0" step="0.01" inputmode="decimal" placeholder="0,00 (sem custo)"></div>
      </div>
    </div>
    <div class="edit-bar"><button class="btn ghost" id="rt-cancel">Cancelar</button><button class="btn primary" id="rt-save">Abrir retorno</button></div>`;
  $("#overlay").scrollTop=0;
  const sair=()=>{ editing=null; renderSheet(orders.find(x=>x.codigo===o.codigo)||o); $("#overlay").scrollTop=0; };
  $("#rt-cancel").onclick=sair; $("#rt-cancel-top").onclick=sair;
  $("#rt-save").onclick=async()=>{
    const sel=[...document.querySelectorAll("[data-ri]")].filter(x=>x.checked).map(x=>(o.itens||[])[+x.dataset.ri]);
    const motivo=U($("#rt-motivo").value.trim());
    if(!sel.length){ toast("Marque o que precisa refazer."); return; }
    if(!motivo){ toast("Descreva o motivo do retorno."); $("#rt-motivo").focus(); return; }
    const valor=round2(Math.max(0,Number($("#rt-valor").value)||0));
    const btn=$("#rt-save"); btn.disabled=true; btn.textContent="Abrindo…";
    const code=newCode(); const now=Date.now(); const por=session?session.nome:"";
    if(o.status!=="entregue"){
      const cur=orders.find(x=>x.codigo===o.codigo)||o;
      const itens=[...(cur.itens||[])]; if(valor) itens.push({nome:"AJUSTE NO RETORNO", preco:valor, qtd:1});
      const sub=round2(itens.reduce((a,i)=>a+(Number(i.preco)||0)*(Number(i.qtd)||0),0));
      const patch={ status:"recebido", costureira:"", emRetorno:true, retornoCount:(cur.retornoCount||0)+1,
        retornoItens:sel.map(i=>U(i.nome)), retornoMotivo:motivo,
        obs:U(`${cur.obs?cur.obs+" · ":""}RETORNO: ${sel.map(i=>U(i.nome)).join(", ")} - ${motivo}`),
        entrega:$("#rt-entrega").value||cur.entrega||"",
        ...(valor?{itens, subtotal:sub, total:round2(sub-(Number(cur.desconto)||0))}:{}),
        historico:[...(cur.historico||[]),{status:"recebido", acao:`Retorno: ${motivo}`, por, em:now}] };
      try{ await db.doc(`pedidos/${o.codigo}`).update(patch); editing=null;
        toast(`Pedido ${o.codigo} voltou para a fila das costureiras.`); renderSheet({...cur, ...patch}); $("#overlay").scrollTop=0; }
      catch(err){ writeErr(err); btn.disabled=false; btn.textContent="Abrir retorno"; }
      return;
    }
    const itens=sel.map(i=>({nome:U(i.nome), preco:0, qtd:i.qtd}));
    if(valor) itens.push({nome:"AJUSTE NO RETORNO", preco:valor, qtd:1});
    const novo={codigo:code, retornoDe:o.codigo, cliente:{nome:U(c.nome||""), telefone:c.telefone||""}, itens,
      subtotal:valor, desconto:0, descontoTipo:"valor", descontoInformado:0, total:valor, entrada:0, pagamento:"Pagar na retirada",
      entrega:$("#rt-entrega").value||"", entregaTipo:o.entregaTipo||"retirada", endereco:o.endereco||"", obs:`RETORNO DO PEDIDO ${o.codigo}: ${motivo}`, fotos:[], audio:null,
      atendente:por, costureira:"", status:"recebido", criadoEm:now,
      historico:[{status:"recebido", acao:`Retorno do pedido ${o.codigo}`, por, em:now}]};
    try{
      await db.doc(`pedidos/${code}`).set(novo);
      const cur=orders.find(x=>x.codigo===o.codigo)||o;
      await db.doc(`pedidos/${o.codigo}`).update({retornos:[...(cur.retornos||[]), code],
        historico:[...(cur.historico||[]),{status:cur.status, acao:`Retorno aberto: ${code}`, por, em:now}]});
      editing=null; toast(`Retorno ${code} aberto. Ele já está na fila das costureiras.`);
      renderSheet(novo); openCode=code; $("#overlay").scrollTop=0;
    }catch(err){ writeErr(err); btn.disabled=false; btn.textContent="Abrir retorno"; }
  };
}
function renderSheet(o){
  sheetKey=(o.historico||[]).length;
  const c=o.cliente||{}; const restante=restOf(o);
  const papel = session ? (session.papel==="gerencia"?"admin":session.papel) : "";
  const verValores = papel!=="costureira";
  const may = {recebido:["costureira"], em_costura:["costureira"], pronto:["atendente","admin"], entregue:[]};
  const mayBack = {em_costura:["costureira"], pronto:["costureira"], entregue:["atendente","admin"]};
  const canNext = (may[o.status]||[]).includes(papel);
  const canBack = (mayBack[o.status]||[]).includes(papel);
  const waitMsg = {recebido:"Aguardando uma costureira pegar o pedido.", em_costura:"Em costura com "+esc(o.costureira||"a costureira")+".", pronto:"Pronto. A atendente entrega à cliente.", entregue:"Pedido entregue."}[o.status]||"";
  const payBox = restante>0?`<div class="paybox"><div class="field"><label for="pg-rest">Cliente pagou ${money(restante)} com</label>
      <select id="pg-rest"><option>Pix</option><option>Dinheiro</option><option>Cartão de débito</option><option>Cartão de crédito</option></select></div></div>`:"";
  const prontoBtn = `<button class="btn pronto-btn" data-st="pronto" data-avisar="1">Pedido pronto · avisar a cliente</button>`;
  const nextBtn = (papel==="atendente" && (o.status==="recebido"||o.status==="em_costura")) ? `<p class="hint">${waitMsg}</p>${prontoBtn}`
    : (papel==="admin" && o.status!=="entregue") ? `${o.status!=="pronto"?`<p class="hint">${waitMsg}</p>${prontoBtn}`:""}${o.status==="pronto"?`<button class="btn" id="ret-pronto">Registrar retorno (a cliente pediu ajuste)</button>`:""}${payBox}<button class="btn primary" data-st="entregue">Marcar como entregue</button>`
    : !canNext ? `<p class="hint">${waitMsg}</p>` : {
    recebido:`<div class="take"><span class="label">Pegar este pedido</span>
      <p style="margin:0">Costureira: <b>${esc(session.nome)}</b></p>
      <div class="field"><label for="tk-local">Onde a peça vai ficar (opcional)</label><input type="text" id="tk-local" placeholder="Ex.: Arara 2, Caixa 5, Bancada da Lúcia" list="locais"></div>
      <div class="thumbs" id="tk-thumb"></div>
      <label class="btn filebtn"><svg><use href="#i-cam"/></svg><span id="tk-ph-txt">Tirar foto da peça que você pegou</span><input type="file" id="tk-ph" accept="image/*" capture="environment"></label>
      <button class="btn primary" id="tk-go">Confirmar e começar a costura</button>
      <p class="hint">O nome e a foto ficam registrados no pedido.</p></div>`,
    em_costura:`<button class="btn primary" data-st="pronto">Marcar como pronto</button>`,
    pronto:`${restante>0?`<div class="paybox"><div class="field"><label for="pg-rest">Cliente pagou ${money(restante)} com</label>
      <select id="pg-rest"><option>Pix</option><option>Dinheiro</option><option>Cartão de débito</option><option>Cartão de crédito</option></select></div></div>`:""}
      <button class="btn primary" data-st="entregue">Entregue à cliente</button>`,
    entregue:``}[o.status]||"";
  const back = {em_costura:"recebido",pronto:"em_costura",entregue:"pronto"}[o.status];
  $("#sheet").innerHTML=`
    <div class="sheet-top"><span class="pill st-${o.status}">${STATUS[o.status]}</span><button class="btn" id="sh-close">Fechar</button></div>
    ${ehPrio(o)?`<div class="prio-banner">★ PEDIDO PRIORITÁRIO</div>`:""}
    ${verValores&&o.status!=="entregue"?`<button type="button" class="prio-toggle" id="sh-prio" aria-pressed="${!!o.prioridade}">${o.prioridade?"★ Prioridade marcada (toque para tirar)":"★ Marcar como prioridade"}</button>`:""}
    ${notaHTML(o,{precos:papel!=="costureira", qr:true})}
    ${verValores?`<div class="panel wa-box"><span class="label">Enviar para a cliente</span>
      ${waNumber(c.telefone)?"":`<div class="field"><label for="wa-tel">WhatsApp da cliente</label><input type="tel" id="wa-tel" placeholder="(81) 9 9999-9999" value="${esc(c.telefone||"")}"></div>`}
      <button class="btn wa" id="wa-img">${waIcon}Enviar nota pelo WhatsApp</button>
      ${o.status==="pronto"?`<a class="btn wa ghostwa" id="wa-pronto" href="${waLink(c.telefone,waProntoText(o))}" ${ehCelular?"":'target="_blank" rel="noopener"'}>${waIcon}Avisar que a peça está pronta</a>`:""}
      <p class="hint" id="wa-msg">${o.whatsEnviadoEm?`Pedido enviado pelo WhatsApp em ${fmtDate(o.whatsEnviadoEm)}. `:""}Abre a conversa de ${esc((c.nome||"").split(" ")[0]||"cliente")}${waNumber(c.telefone)?" ("+esc(c.telefone)+")":""} com o texto “Segue o seu pedido” pronto e a imagem copiada: toque e segure na caixa de mensagem, escolha <b>Colar</b> e envie junto com o texto.</p>
    </div>`:""}
    ${verValores?`<div class="panel print-box"><span class="label">Imprimir (80 mm)</span>
      <button class="btn primary" id="print-now">Imprimir</button>
      <div class="grid2"><button class="btn" id="print-browser">Imprimir pelo navegador</button><button class="btn" data-print="80">Baixar PDF 80 mm</button></div>
      <p class="hint" id="print-msg">Abre o compartilhar do celular: escolha o <b>Fun Print</b>. A impressão sai sem valores, só com os serviços, as observações e o QR code.</p>
    </div>`:""}
    ${o.audio?`<div class="panel"><span class="label">Áudio da atendente</span><div id="sh-audio" class="busy muted"><span class="spin"></span>Carregando áudio…</div></div>`:""}
    ${(o.fotos||[]).length?`<div class="panel"><span class="label">Fotos da peça</span><div class="thumbs" id="sh-photos">${o.fotos.map(()=>`<div class="thumb"></div>`).join("")}</div></div>`:""}
    ${o.status!=="entregue" && papel==="costureira"?`<div class="panel"><span class="label">Local da peça</span><div class="locbox"><input type="text" id="sh-local" value="${esc(o.local||"")}" placeholder="Ex.: Arara 2, Caixa 5" list="locais" aria-label="Local da peça"><button class="btn" id="sh-local-save">Salvar</button></div></div>`:(o.local?`<div class="panel"><span class="label">Local da peça</span><b>${esc(o.local)}</b></div>`:"")}
    ${o.costureira?`<div class="panel"><span class="label">Pego pela costureira</span><div class="proof"><div class="thumb" id="sh-take">${o.fotoCostureira?"":'<span class="muted" style="font-size:12px;padding:8px;display:block">sem foto</span>'}</div><div><b>${esc(o.costureira)}</b><span class="muted">${o.pegoEm?fmtDate(o.pegoEm):""}</span></div></div></div>`:""}
    <div class="panel"><span class="label">Andamento</span>
      <div class="hist">${(o.historico||[]).map(h=>`<span>${fmtDate(h.em)} · <b>${h.acao?esc(h.acao):STATUS[h.status]}</b>${h.por?" · "+esc(h.por):""}</span>`).join("")}</div>
      <div class="actions">${nextBtn}${back&&canBack?`<button class="btn ghost" data-st="${back}">Voltar para “${STATUS[back]}”</button>`:""}</div>
    </div>
    ${papel==="admin" && o.status==="entregue" && !o.retornoDe?`<div class="panel ret-box"><span class="label">Retorno da cliente</span>
      <p class="hint">Use quando a cliente voltar para refazer algum ajuste. Este pedido continua guardado como está, e um pedido de retorno ligado a ele vai para a fila das costureiras.</p>
      ${(o.retornos||[]).length?`<p class="hint">Retornos já abertos: ${o.retornos.map(r=>`<button class="link-btn" data-open="${esc(r)}">${esc(r)}</button>`).join(" ")}</p>`:""}
      <button class="btn" id="ret-open">Registrar retorno</button></div>`:""}
    ${o.retornoDe?`<div class="panel"><span class="label">Pedido original</span><button class="btn ghost" data-open="${esc(o.retornoDe)}">Abrir pedido ${esc(o.retornoDe)}</button></div>`:""}
    ${papel==="admin"?`<div class="panel"><span class="label">Editar pedido</span>
      <p class="hint">Altere cliente, serviços, valores, desconto, entrada, entrega e observações.</p>
      <button class="btn" id="edit-ord">Editar pedido</button></div>`:""}
    ${canDelete(o)?`<div class="panel danger-zone"><span class="label" style="color:var(--danger)">Excluir pedido</span>
      <p class="hint">Apaga o pedido, as fotos e o áudio. Não dá para desfazer.</p>
      <button class="btn del" id="del-ord">Excluir pedido ${esc(o.codigo)}</button></div>`:""}`;
  $("#sh-close").onclick=closeSheet;
  const shp=$("#sh-prio"); if(shp) shp.onclick=async()=>{ shp.disabled=true; const v=!o.prioridade;
    try{ await db.doc(`pedidos/${o.codigo}`).update({prioridade:v}); o.prioridade=v; const x=orders.find(z=>z.codigo===o.codigo); if(x) x.prioridade=v; renderSheet(o);
      toast(v?"Pedido marcado como prioridade.":"Prioridade retirada."); }catch(e){ writeErr(e); shp.disabled=false; } };
  if($("#qr")) try{ new QRCode($("#qr"),{text:qrText(o.codigo),width:264,height:264,colorDark:"#111111",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.Q}); }catch(e){ $("#qr").textContent=""; }
  $("#sheet").querySelectorAll("[data-st]").forEach(b=>b.onclick=()=>changeStatus(o.codigo,b.dataset.st,b));
  if(o.status==="recebido" && $("#tk-go")) wireTake(o);
  const db_=$("#del-ord"); if(db_) db_.onclick=()=>deleteOrder(o,db_);
  const ed_=$("#edit-ord"); if(ed_) ed_.onclick=()=>renderEdit(o);
  const rt_=$("#ret-open"); if(rt_) rt_.onclick=()=>renderRetorno(o);
  const rp_=$("#ret-pronto"); if(rp_) rp_.onclick=()=>renderRetorno(o);
  $("#sheet").querySelectorAll("[data-print]").forEach(b=>b.onclick=()=>printNota(o.codigo,b.dataset.print,b));
  if(verValores){
  wireWhats(o);
  wirePrint(o);
  }
  const ls_=$("#sh-local-save"); if(ls_) ls_.onclick=async()=>{ const v=$("#sh-local").value.trim(); if(v===(o.local||"")) return; ls_.disabled=true;
    try{ await db.doc(`pedidos/${o.codigo}`).update({local:v}); toast(v?`Local salvo: ${v}.`:"Local removido."); }catch(err){ writeErr(err); } ls_.disabled=false; };
  if(o.fotoCostureira) loadBlob(o.fotoCostureira).then(u=>{const t=$("#sh-take"); if(t) t.innerHTML=`<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="Foto da costureira ao pegar o pedido"></a>`;}).catch(()=>{});
  if(o.audio) loadBlob(o.audio).then(u=>{const el=$("#sh-audio"); if(el){el.className="audio-box"; el.innerHTML=`<audio controls src="${u}"></audio>`;}}).catch(()=>{const el=$("#sh-audio"); if(el){el.className="muted"; el.textContent="Não foi possível carregar o áudio.";}});
  (o.fotos||[]).forEach((id,i)=>loadBlob(id).then(u=>{const t=document.querySelectorAll("#sh-photos .thumb")[i]; if(t) t.innerHTML=`<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="Foto ${i+1} da peça"></a>`;}).catch(()=>{}));
}
function renderTakeThumb(){
  const el=$("#tk-thumb"); if(!el) return;
  el.innerHTML = takePhoto ? `<div class="thumb"><img src="${takePhoto.url}" alt="Foto ao pegar o pedido"><button class="x" id="tk-rm" aria-label="Remover foto">×</button></div>` : "";
  $("#tk-ph-txt").textContent = takePhoto ? "Tirar outra foto" : "Tirar foto da peça que você pegou";
  const rm=$("#tk-rm"); if(rm) rm.onclick=()=>{URL.revokeObjectURL(takePhoto.url); takePhoto=null; renderTakeThumb();};
}
function wireTake(o){
  renderTakeThumb();
  $("#tk-ph").addEventListener("change",async e=>{
    const f=e.target.files[0]; e.target.value=""; if(!f) return;
    if(!/^image\//.test(f.type||"image/") || f.size>30*1024*1024){ toast("Esse arquivo não é uma foto válida."); return; }
    try{ const b=await compressImage(f,1200,.7); if(takePhoto) URL.revokeObjectURL(takePhoto.url); takePhoto={blob:b,url:URL.createObjectURL(b)}; renderTakeThumb(); }
    catch(err){ toast("Não consegui abrir essa foto."); }
  });
  $("#tk-go").onclick=async()=>{
    const nome=session?session.nome:"";
    if(!nome) return;
    if(!takePhoto){ toast("Tire a foto da peça antes de confirmar."); return; }
    if(!db) return;
    const btn=$("#tk-go"); btn.disabled=true; btn.innerHTML='<span class="busy"><span class="spin"></span>Enviando foto</span>';
    try{
      const fotoId=await saveBlob(takePhoto.blob,"retirada");
      const cur=orders.find(x=>x.codigo===o.codigo)||o; const now=Date.now();
      await db.doc(`pedidos/${o.codigo}`).update({status:"em_costura", costureira:nome, fotoCostureira:fotoId, pegoEm:now, local:($("#tk-local")?$("#tk-local").value.trim():"")||cur.local||"",
        historico:[...(cur.historico||[]),{status:"em_costura", por:nome, em:now}]});
      URL.revokeObjectURL(takePhoto.url); takePhoto=null;
      toast(`Pedido ${o.codigo} é seu, ${nome}.`);
    }catch(err){ writeErr(err); btn.disabled=false; btn.textContent="Confirmar e começar a costura"; }
  };
}
function canDelete(o){ const p=session?session.papel:""; return p==="admin" || p==="gerencia" || (p==="atendente" && o.status!=="entregue"); }
async function deleteOrder(o,btn){
  if(!btn.classList.contains("armed")){
    btn.classList.add("armed"); btn.textContent="Toque de novo para confirmar a exclusão";
    clearTimeout(btn._t); btn._t=setTimeout(()=>{ btn.classList.remove("armed"); btn.textContent=`Excluir pedido ${o.codigo}`; },5000);
    return;
  }
  clearTimeout(btn._t); btn.disabled=true; btn.innerHTML='<span class="busy"><span class="spin"></span>Excluindo</span>';
  try{
    const ids=[...(o.fotos||[]), o.audio, o.fotoCostureira].filter(Boolean);
    await db.doc(`pedidos/${o.codigo}`).delete();
    db.doc(`publico/${o.codigo}`).delete().catch(()=>{});
    closeSheet(); toast(`Pedido ${o.codigo} excluído.`);
    for(const id of ids){ try{ const m=await db.doc(`arquivos/${id}`).get(); const n=m.exists?(m.data().n||0):0;
      for(let i=0;i<n;i++) await db.doc(`arquivos/${id}/partes/p${i}`).delete();
      await db.doc(`arquivos/${id}`).delete(); blobCache.delete(id); }catch(e){ console.warn(e); } }
  }catch(e){ writeErr(e); btn.disabled=false; btn.classList.remove("armed"); btn.textContent=`Excluir pedido ${o.codigo}`; }
}
async function changeStatus(code, st, btn){
  const o=orders.find(x=>x.codigo===code); if(!o||!db) return;
  if(st==="entregue" && o.status!=="entregue"){ const tel=(o.cliente||{}).telefone; if(waNumber(tel)) abrirWA(tel,waEntregueText(o)); }
  if(st==="pronto" && o.status!=="pronto" && btn && btn.dataset.avisar){ const tel=(o.cliente||{}).telefone; if(waNumber(tel)) abrirWA(tel,waProntoText({...o,status:"pronto"})); else toast("Pedido marcado como pronto. A cliente não tem WhatsApp cadastrado."); }
  const por = session ? session.nome : "";
  btn.disabled=true;
  const patch={status:st, historico:[...(o.historico||[]),{status:st, por, em:Date.now()}]};
  if(st==="em_costura") patch.costureira=por;
  if(st==="entregue"){ patch.entregueEm=Date.now(); patch.entreguePor=por; const r=restOf(o); patch.valorRetirada=r; patch.pagamentoRetirada= r>0 && $("#pg-rest") ? $("#pg-rest").value : ""; }
  if(o.status==="entregue" && st!=="entregue"){ patch.entregueEm=null; patch.entreguePor=""; patch.valorRetirada=0; patch.pagamentoRetirada=""; }
  try{ await db.doc(`pedidos/${code}`).update(patch); toast(`Pedido ${code}: ${STATUS[st]}.`);
    db.doc(`publico/${code}`).get().then(d=>{ if(d.exists) publicar({...o,...patch}); }).catch(()=>{}); }
  catch(e){ writeErr(e); btn.disabled=false; }
}

/* ---------- costureiras: QR ---------- */
function extractCode(t){ const m=String(t||"").toUpperCase().match(/CE-[A-Z0-9]{6}/); return m?m[0]:null; }
$("#code-go").addEventListener("click",()=>{ const c=extractCode($("#code-in").value) || $("#code-in").value; openOrder(c); });
$("#code-in").addEventListener("keydown",e=>{ if(e.key==="Enter") $("#code-go").click(); });
$("#app-link").value=ARTIFACT_URL;
$("#copy-link").addEventListener("click",()=>{
  navigator.clipboard.writeText(ARTIFACT_URL).then(()=>toast("Link copiado. Cole no navegador do celular."))
    .catch(()=>{ const i=$("#app-link"); i.focus(); i.select(); toast("Selecione e copie o link."); });
});
async function onQrFile(e){
  const f=e.target.files[0]; e.target.value=""; if(!f) return;
  const st=$("#scan-status"); const prev=URL.createObjectURL(f);
  st.hidden=false; st.innerHTML=`<img src="${prev}" alt=""><span class="busy"><span class="spin"></span>Lendo o QR code…</span>`;
  try{
    await ensureJsQR();
    const txt = await decodeQR(f);
    const code = extractCode(txt);
    if(code){ st.innerHTML=`<img src="${prev}" alt=""><span>Lido: ${esc(code)}</span>`; openOrder(code); setTimeout(()=>{st.hidden=true; URL.revokeObjectURL(prev);},2500); }
    else st.innerHTML=`<img src="${prev}" alt=""><span>Não encontrei o QR nesta foto. Chegue mais perto, centralize o QR e evite reflexo. Ou digite o código abaixo.</span>`;
  }catch(err){ console.error(err); st.innerHTML=`<span>Não consegui abrir a foto. Tente de novo ou digite o código.</span>`; }
}
$("#qr-gal").addEventListener("change", onQrFile);

/* ---------- leitor ao vivo pela câmera ---------- */
let scanStream=null, scanRaf=0, scanBusy=false, scanDet=null, scanLast=0, scanN=0;
async function openScanner(){
  const msg=$("#scan-msg"); $("#scanner").hidden=false; document.body.style.overflow="hidden";
  msg.textContent="Abrindo a câmera…";
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ msg.textContent="Este navegador não abre a câmera. Use “Ler o QR de uma foto” ou digite o código."; return; }
  try{
    scanStream=await navigator.mediaDevices.getUserMedia({audio:false, video:{facingMode:{ideal:"environment"}, width:{ideal:1280}, height:{ideal:720}}});
  }catch(e){
    console.warn(e);
    msg.textContent = e && e.name==="NotAllowedError" ? "A câmera foi bloqueada. Toque no cadeado ao lado do endereço do site e permita a câmera." : "Não consegui abrir a câmera. Use “Ler o QR de uma foto” ou digite o código.";
    return;
  }
  const v=$("#scan-video"); v.srcObject=scanStream; try{ await v.play(); }catch(e){}
  msg.textContent="Lendo…";
  try{ const tr=scanStream.getVideoTracks()[0]; const cap=tr.getCapabilities&&tr.getCapabilities(); $("#scan-torch").hidden=!(cap&&cap.torch); }catch(e){}
  scanDet=null;
  if("BarcodeDetector" in window){ try{ const f=await BarcodeDetector.getSupportedFormats(); if(f.includes("qr_code")) scanDet=new BarcodeDetector({formats:["qr_code"]}); }catch(e){} }
  const cv=document.createElement("canvas"); const ctx=cv.getContext("2d",{willReadFrequently:true});
  const tick=async(t)=>{
    if(!scanStream) return;
    scanRaf=requestAnimationFrame(tick);
    if(scanBusy || t-scanLast<120 || v.readyState<2) return;
    scanLast=t; scanBusy=true;
    try{
      let txt=null;
      if(scanDet){ const r=await scanDet.detect(v); if(r&&r[0]) txt=r[0].rawValue; }
      if(!txt && window.jsQR){
        const vw=v.videoWidth, vh=v.videoHeight; scanN++;
        let sx=0, sy=0, sw=vw, sh=vh;
        if(scanN%2){ const side=Math.min(vw,vh)*0.8; sx=(vw-side)/2; sy=(vh-side)/2; sw=sh=side; }
        const k=Math.min(1,720/Math.max(sw,sh)); const w=Math.round(sw*k), h=Math.round(sh*k);
        cv.width=w; cv.height=h; ctx.drawImage(v,sx,sy,sw,sh,0,0,w,h);
        const r=jsQR(ctx.getImageData(0,0,w,h).data,w,h,{inversionAttempts:"attemptBoth"}); if(r&&r.data) txt=r.data;
      }
      const code=extractCode(txt);
      if(code){ try{ navigator.vibrate&&navigator.vibrate(80); }catch(e){} closeScanner(); openOrder(code); }
      else if(txt){ msg.textContent="Esse QR não é de um pedido da Costura Expressa."; }
    }catch(e){ console.warn(e); }
    scanBusy=false;
  };
  scanRaf=requestAnimationFrame(tick);
}
function closeScanner(){
  cancelAnimationFrame(scanRaf); scanRaf=0; scanBusy=false;
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream=null; }
  const v=$("#scan-video"); v.srcObject=null;
  $("#scanner").hidden=true; document.body.style.overflow="";
}
$("#scan-live").addEventListener("click",openScanner);
$("#scan-close").addEventListener("click",closeScanner);
$("#scan-torch").addEventListener("click",async()=>{ try{ const tr=scanStream&&scanStream.getVideoTracks()[0]; if(!tr) return; tr._on=!tr._on; await tr.applyConstraints({advanced:[{torch:tr._on}]}); }catch(e){ toast("A lanterna não está disponível."); } });
document.addEventListener("visibilitychange",()=>{ if(document.hidden && scanStream) closeScanner(); });
function saveFile(blob,filename){
  const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function ensureJsQR(){
  if(window.jsQR) return Promise.resolve();
  return new Promise(res=>{ const sc=document.createElement("script"); sc.src="jsQR.min.js"; sc.onload=res; sc.onerror=res; document.head.appendChild(sc); setTimeout(res,6000); });
}
async function decodeQR(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url;});
    if("BarcodeDetector" in window){ try{ const det=new BarcodeDetector({formats:["qr_code"]}); const r=await det.detect(img); if(r[0]) return r[0].rawValue; }catch(e){} }
    if(!window.jsQR) return null;
    const W=img.naturalWidth||img.width, H=img.naturalHeight||img.height;
    // tenta a foto inteira em vários tamanhos e depois recortes do centro
    const crops=[[0,0,1],[.15,.15,.7],[.25,.25,.5],[.08,.08,.84],[0,0,.6],[.4,0,.6],[0,.4,.6],[.4,.4,.6]];
    const sizes=[800,1200,500,1600,350];
    for(const [fx,fy,fs] of crops){
      const sx=W*fx, sy=H*fy, sw=W*fs, sh=H*fs;
      for(const max of sizes){
        const k=Math.min(1,max/Math.max(sw,sh)); const w=Math.max(1,Math.round(sw*k)), h=Math.max(1,Math.round(sh*k));
        const c=document.createElement("canvas"); c.width=w; c.height=h; const ctx=c.getContext("2d",{willReadFrequently:true});
        ctx.drawImage(img,sx,sy,sw,sh,0,0,w,h);
        const data=ctx.getImageData(0,0,w,h);
        let r=jsQR(data.data,w,h,{inversionAttempts:"attemptBoth"});
        if(r && r.data) return r.data;
        // reforço de contraste
        const d=data.data; for(let i=0;i<d.length;i+=4){ const y=.299*d[i]+.587*d[i+1]+.114*d[i+2]; const v=y<128?Math.max(0,y*.6-10):Math.min(255,y*1.25+20); d[i]=d[i+1]=d[i+2]=v; }
        r=jsQR(d,w,h,{inversionAttempts:"dontInvert"});
        if(r && r.data) return r.data;
        await new Promise(z=>setTimeout(z,0));
      }
    }
    return null;
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- serviços (cadastro) ---------- */
let pendingDel=null;
function renderSvcEdit(){
  const el=$("#svc-edit-list");
  if(!services.length){
    el.innerHTML=`<div class="empty"><span>A tabela está vazia. Cadastre acima ou comece com uma lista comum de ateliê e ajuste os valores.</span><button class="btn" id="s-seed">Usar lista sugerida</button></div>`;
    $("#s-seed").onclick=seedServices; return;
  }
  const q0=norm($("#svc-busca2").value).trim();
  const lista=q0?services.filter(s=>norm(s.nome).includes(q0)):services;
  if(!lista.length){ el.innerHTML=`<div class="svc-list"><div class="svc-none">Nenhum serviço encontrado com “${esc(U($("#svc-busca2").value))}”.</div></div>`; return; }
  el.innerHTML=`<div class="svc-list">${lista.map(s=>`<div class="svc-edit"><span class="nm">${esc(s.nome)}</span>
    <input type="number" step="0.01" min="0" inputmode="decimal" id="pr-${s.id}" data-price="${s.id}" value="${Number(s.preco).toFixed(2)}" aria-label="Valor de ${esc(s.nome)}">
    <button class="btn ghost ${pendingDel===s.id?"danger":""}" data-del="${s.id}" style="min-height:40px;padding:8px 10px">${pendingDel===s.id?"Confirmar":"Excluir"}</button></div>`).join("")}</div>`;
}
$("#svc-edit-list").addEventListener("change",async e=>{
  const id=e.target.dataset.price; if(!id) return; const v=Math.max(0,Number(e.target.value)||0);
  const s=services.find(x=>x.id===id); if(!s||s.preco===v) return;
  try{ await db.doc(`servicos/${id}`).update({preco:v}); toast("Valor atualizado."); }catch(err){ writeErr(err); }
});
$("#svc-edit-list").addEventListener("click",async e=>{
  const b=e.target.closest("[data-del]"); if(!b) return; const id=b.dataset.del;
  if(pendingDel!==id){ pendingDel=id; renderSvcEdit(); setTimeout(()=>{ if(pendingDel===id){pendingDel=null; renderSvcEdit();} },4000); return; }
  pendingDel=null;
  try{ await db.doc(`servicos/${id}`).delete(); delete cart[id]; toast("Serviço excluído."); }catch(err){ writeErr(err); }
});
$("#s-add").addEventListener("click",async()=>{
  const nome=$("#s-nome").value.trim(); const preco=Number($("#s-preco").value);
  if(!nome){toast("Digite o nome do serviço."); return;}
  if(!(preco>=0) || $("#s-preco").value===""){toast("Digite o valor do serviço."); return;}
  if(!db){toast("Ainda conectando."); return;}
  try{ await db.collection("servicos").add({nome, preco, criadoEm:Date.now()}); $("#s-nome").value=""; $("#s-preco").value=""; $("#s-nome").focus(); toast("Serviço adicionado."); }
  catch(err){ writeErr(err); }
});
async function seedServices(){
  const base=[["Barra de calça",20],["Barra de calça jeans (original)",30],["Ajuste de cintura",35],["Apertar laterais",30],["Encurtar manga",25],["Troca de zíper",25],["Bainha de vestido",35],["Ajuste de alças",15],["Pregar botão",5],["Remendo / cerzido",20]];
  try{ for(const [nome,preco] of base){ await db.collection("servicos").add({nome:U(nome),preco,criadoEm:Date.now()}); } toast("Lista sugerida adicionada. Ajuste os valores."); }
  catch(err){ writeErr(err); }
}

/* ---------- login ---------- */
// Senhas: PBKDF2-SHA256 com 210 mil iterações e sal aleatório (WebCrypto). O formato antigo (SHA-256 simples)
// ainda é aceito para não trancar ninguém e é convertido para o novo no primeiro login certo.
const PIN_ALG="pbkdf2-sha256-210000";
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function hashPinLegado(salt,pin){ return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(salt+":"+pin))); }
async function hashPin(salt,pin){
  const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(String(pin)),"PBKDF2",false,["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:new TextEncoder().encode(String(salt)),iterations:210000},k,256));
}
async function pinConfere(m,pin){
  if(!m || !m.pinHash || !m.salt) return false;
  const ok = m.pinAlg===PIN_ALG ? (await hashPin(m.salt,pin))===m.pinHash : (await hashPinLegado(m.salt,pin))===m.pinHash;
  if(ok && m.pinAlg!==PIN_ALG && db){ try{ const salt=randSalt(); await db.doc(`equipe/${m.id}`).update({salt,pinHash:await hashPin(salt,pin),pinAlg:PIN_ALG}); }catch(e){ console.warn(e); } }
  return ok;
}
// Limite de tentativas por pessoa neste aparelho: depois de 5 erros, espera 30 s, depois 1 min, 2 min... até 15 min.
const tentKey=id=>"ce-tent-"+id;
function tentLer(id){ try{ return JSON.parse(localStorage.getItem(tentKey(id))||"{}"); }catch(e){ return {}; } }
function tentGravar(id,v){ try{ if(v) localStorage.setItem(tentKey(id),JSON.stringify(v)); else localStorage.removeItem(tentKey(id)); }catch(e){} }
function tentBloqueio(id){ const t=tentLer(id); return t.ate && t.ate>Date.now() ? Math.ceil((t.ate-Date.now())/1000) : 0; }
function tentErro(id){ const t=tentLer(id); const n=(t.n||0)+1; let ate=0; if(n>=5){ ate=Date.now()+Math.min(900,30*Math.pow(2,n-5))*1000; } tentGravar(id,{n,ate}); }
function randSalt(){ return [...crypto.getRandomValues(new Uint8Array(12))].map(x=>x.toString(16).padStart(2,"0")).join(""); }
const validPin = p => /^\d{4,6}$/.test(p);
const initials = n => String(n||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase();

function renderLogin(){
  const el=$("#login-body");
  if(!db){ return; }
  if(!teamLoaded){ el.innerHTML="<p>Carregando a equipe…</p>"; return; }
  const ownerLink = "";
  if(!team.length){
    el.innerHTML=`<div class="grp" style="gap:14px"><h2>Primeiro acesso</h2><p>Crie o acesso de administração. Depois você cadastra as atendentes e costureiras na aba Equipe.</p>
      <div class="field"><label for="lg-nome">Seu nome</label><input type="text" id="lg-nome" autocomplete="off"></div>
      <div class="field"><label for="lg-pin">Senha de 4 a 6 números</label><input class="pin" type="password" id="lg-pin" inputmode="numeric" maxlength="6" autocomplete="off"></div>
      ${loginErr?`<div class="err">${esc(loginErr)}</div>`:""}
      <button class="btn primary" id="lg-create">Criar e entrar</button></div>`;
    $("#lg-create").onclick=async()=>{
      const nome=$("#lg-nome").value.trim(), pin=$("#lg-pin").value.trim();
      if(!nome){loginErr="Digite seu nome."; renderLogin(); return;}
      if(!validPin(pin)){loginErr="A senha precisa ter de 4 a 6 números."; renderLogin(); return;}
      try{ const salt=randSalt(); const ref=await db.collection("equipe").add({nome,papel:"admin",salt,pinHash:await hashPin(salt,pin),pinAlg:PIN_ALG,criadoEm:Date.now()});
        loginErr=""; startSession({id:ref.path.split("/").pop(),nome,papel:"admin"}); }catch(e){ writeErr(e); }
    };
    return;
  }
  if(!loginPick){
    const grp=(p,t)=>{const m=team.filter(x=>x.papel===p); return m.length?`<div class="grp"><span class="label">${t}</span>${m.map(x=>`<button class="member" data-pick="${esc(x.id)}"><span class="av">${esc(initials(x.nome))}</span><span><b>${esc(x.nome)}</b><small>${esc(ROLES[x.papel]||"")}</small></span></button>`).join("")}</div>`:"";};
    el.innerHTML=`<div class="grp" style="gap:18px"><h2>Quem está entrando?</h2>${grp("gerencia","Gerência")}${grp("admin","Administração")}${grp("atendente","Atendimento")}${grp("costureira","Costureiras")}${ownerLink}</div>`;
    el.querySelectorAll("[data-pick]").forEach(b=>b.onclick=()=>{loginPick=team.find(x=>x.id===b.dataset.pick); loginErr=""; renderLogin();});
  } else {
    el.innerHTML=`<div class="grp" style="gap:14px">
      <button class="member" disabled style="cursor:default"><span class="av">${esc(initials(loginPick.nome))}</span><span><b>${esc(loginPick.nome)}</b><small>${ROLES[loginPick.papel]}</small></span></button>
      <div class="field"><label for="lg-pin">Senha</label><input class="pin" type="password" id="lg-pin" inputmode="numeric" maxlength="6" autocomplete="off"></div>
      ${loginErr?`<div class="err">${esc(loginErr)}</div>`:""}
      <button class="btn primary" id="lg-go">Entrar</button>
      <button class="btn ghost" id="lg-back">Trocar de pessoa</button></div>`;
    const go=async()=>{
      const pin=$("#lg-pin").value.trim(); const m=loginPick; if(!m) return;
      const bl=tentBloqueio(m.id); if(bl){ loginErr=`Muitas tentativas erradas. Espere ${bl>=60?Math.ceil(bl/60)+" min":bl+" s"} e tente de novo.`; renderLogin(); return; }
      if(!validPin(pin)){ loginErr="Digite a senha de 4 a 6 números."; renderLogin(); return; }
      const b=$("#lg-go"); if(b){ b.disabled=true; b.textContent="Conferindo…"; }
      if(await pinConfere(m,pin)){ tentGravar(m.id,null); loginErr=""; loginPick=null; startSession({id:m.id,nome:m.nome,papel:m.papel}); }
      else { tentErro(m.id); const bl2=tentBloqueio(m.id); loginErr = bl2 ? `Senha incorreta. Muitas tentativas: espere ${bl2>=60?Math.ceil(bl2/60)+" min":bl2+" s"}.` : "Senha incorreta. Tente de novo."; renderLogin(); }
    };
    $("#lg-go").onclick=go;
    $("#lg-pin").addEventListener("keydown",e=>{ if(e.key==="Enter") go(); });
    $("#lg-back").onclick=()=>{loginPick=null; loginErr=""; renderLogin();};
    setTimeout(()=>$("#lg-pin")&&$("#lg-pin").focus(),50);
  }
}
function startSession(s){
  session=s; ls.set("ce-sess",s.id);
  $("#login").hidden=true; $("#who").hidden=false;
  $("#who-name").textContent=s.nome; $("#who-role").textContent=ROLES[s.papel];
  $("#c-atend").value=s.nome; $("#cost-nome").value=s.nome;

  setView("menu",true);
  renderRecent(); renderQueue(); renderLogi(); renderEntregues(); renderCaixa(); renderProducao(); renderPedidos(); renderClientes(); renderFaturamento(); renderDespesas(); renderDoDia(); if(curView==="menu") renderMenu();
  if(hashCode && ordersLoaded && !hashOpened){ hashOpened=true; openOrder(hashCode); }
}
function logout(){
  session=null; ls.set("ce-sess",""); closeSheet(); resetForm();
  $("#who").hidden=true; $("#login").hidden=false; loginPick=null; loginErr=""; renderLogin();
}
$("#logout").addEventListener("click",logout);

/* ---------- equipe ---------- */
function renderTeam(){
  const el=$("#team-list"); if(!el) return;
  if(!team.length){ el.innerHTML=`<div class="empty">Nenhum acesso criado.</div>`; return; }
  const order={gerencia:0,admin:1,atendente:2,costureira:3};
  const list=[...team].sort((a,b)=>(order[a.papel]-order[b.papel])||String(a.nome).localeCompare(b.nome,"pt-BR"));
  el.innerHTML=`<div class="svc-list">${list.map(m=>`<div class="mem-row">
    <div style="min-width:0"><div class="nm">${esc(m.nome)}${session&&session.id===m.id?' <span class="muted" style="font-weight:400">(você)</span>':""}</div><span class="pill r-${m.papel}">${ROLES[m.papel]}</span></div>
    <div class="acts"><button class="btn ghost" data-pin="${esc(m.id)}">Trocar senha</button>${session&&session.id===m.id?"":`<button class="btn ghost ${pendingMemDel===m.id?"danger":""}" data-mdel="${esc(m.id)}">${pendingMemDel===m.id?"Confirmar":"Remover"}</button>`}</div>
    ${pinEdit===m.id?`<div class="pinbox"><input type="text" id="pe-${m.id}" inputmode="numeric" maxlength="6" placeholder="Nova senha" aria-label="Nova senha de ${esc(m.nome)}"><button class="btn primary" data-pinsave="${m.id}">Salvar</button></div>`:""}
  </div>`).join("")}</div>`;
}
$("#team-list").addEventListener("click",async e=>{
  const p=e.target.closest("[data-pin]"), d=e.target.closest("[data-mdel]"), sv=e.target.closest("[data-pinsave]");
  if(p){ pinEdit = pinEdit===p.dataset.pin?null:p.dataset.pin; renderTeam(); const i=$("#pe-"+pinEdit); if(i) i.focus(); }
  if(sv){ const id=sv.dataset.pinsave; const pin=$("#pe-"+id).value.trim();
    if(!validPin(pin)){toast("A senha precisa ter de 4 a 6 números."); return;}
    try{ const salt=randSalt(); await db.doc(`equipe/${id}`).update({salt,pinHash:await hashPin(salt,pin),pinAlg:PIN_ALG}); pinEdit=null; renderTeam(); toast("Senha alterada."); }catch(err){ writeErr(err); } }
  if(d){ const id=d.dataset.mdel; const m=team.find(x=>x.id===id);
    if(m && (m.papel==="admin"||m.papel==="gerencia") && team.filter(x=>x.papel==="admin"||x.papel==="gerencia").length<2){ toast("Mantenha pelo menos um acesso de administração ou gerência."); return; }
    if(pendingMemDel!==id){ pendingMemDel=id; renderTeam(); setTimeout(()=>{ if(pendingMemDel===id){pendingMemDel=null; renderTeam();} },4000); return; }
    pendingMemDel=null; try{ await db.doc(`equipe/${id}`).delete(); toast("Acesso removido."); }catch(err){ writeErr(err); } }
});
$("#m-add").addEventListener("click",async()=>{
  const nome=$("#m-nome").value.trim(), papel=$("#m-papel").value, pin=$("#m-pin").value.trim();
  if(!nome){toast("Digite o nome."); return;}
  if(!validPin(pin)){toast("A senha precisa ter de 4 a 6 números."); return;}
  if(team.some(x=>x.nome.toLowerCase()===nome.toLowerCase())){toast("Já existe alguém com esse nome."); return;}
  try{ const salt=randSalt(); await db.collection("equipe").add({nome,papel,salt,pinHash:await hashPin(salt,pin),pinAlg:PIN_ALG,criadoEm:Date.now()});
    $("#m-nome").value=""; $("#m-pin").value=""; toast(`Acesso de ${nome} criado.`); }catch(err){ writeErr(err); }
});


/* ---------- banco local (um aparelho só, IndexedDB) ---------- */
async function localDB(){
  const idb=await new Promise((res,rej)=>{ const r=indexedDB.open("costura-expressa",1); r.onupgradeneeded=()=>r.result.createObjectStore("docs"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  const store=new Map();
  await new Promise((res,rej)=>{ const tx=idb.transaction("docs"); const os=tx.objectStore("docs"); const rq=os.openCursor();
    rq.onsuccess=()=>{ const c=rq.result; if(c){ store.set(c.key,c.value); c.continue(); } else res(); }; rq.onerror=()=>rej(rq.error); });
  const put=(k,v)=>new Promise((res,rej)=>{ const tx=idb.transaction("docs","readwrite"); v===undefined?tx.objectStore("docs").delete(k):tx.objectStore("docs").put(v,k); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
  const listeners=new Set(); const notify=()=>setTimeout(()=>listeners.forEach(f=>f()),0);
  const clone=o=>JSON.parse(JSON.stringify(o));
  const snap=p=>{ const d=store.get(p); return {id:p.split("/").pop(), exists:!!d, data:()=>d?clone(d):undefined}; };
  const rid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  function docRef(p){ return {path:p, id:p.split("/").pop(),
    get:async()=>snap(p),
    set:async d=>{ const v=clone(d); store.set(p,v); await put(p,v); notify(); },
    update:async d=>{ if(!store.has(p)) throw {code:"not-found"}; const v={...store.get(p),...clone(d)}; store.set(p,v); await put(p,v); notify(); },
    delete:async()=>{ store.delete(p); await put(p,undefined); notify(); },
    collection:c=>colRef(p+"/"+c)}; }
  function query(p,ord,lim){
    const run=()=>{ const depth=p.split("/").length+1;
      let docs=[...store.keys()].filter(k=>k.startsWith(p+"/")&&k.split("/").length===depth).map(snap);
      if(ord) docs.sort((a,b)=>{ const x=a.data()[ord[0]], y=b.data()[ord[0]]; return (x<y?-1:x>y?1:0)*(ord[1]==="desc"?-1:1); });
      if(lim) docs=docs.slice(0,lim); return {docs,size:docs.length,empty:!docs.length}; };
    return {orderBy:(f,d)=>query(p,[f,d||"asc"],lim), limit:l=>query(p,ord,l), get:async()=>run(),
      onSnapshot:cb=>{ const f=()=>cb(run()); listeners.add(f); setTimeout(f,0); return ()=>listeners.delete(f); }};
  }
  function colRef(p){ return {...query(p), path:p, doc:id=>docRef(p+"/"+(id||rid())), add:async d=>{ const r=docRef(p+"/"+rid()); await r.set(d); return r; }}; }
  try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persist(); }catch(e){}
  return {doc:docRef, collection:colRef};
}

/* ---------- app instalável ---------- */
let installEvt=null;
const isStandalone=()=>window.matchMedia("(display-mode: standalone)").matches || navigator.standalone===true;
function showInstall(){
  const can=!!installEvt && !isStandalone();
  $("#install-login").hidden=!can;
  let dismissed=false; try{ dismissed=Date.now()-Number(localStorage.getItem("ce-install-x")||0) < 7*864e5; }catch(e){}
  $("#install-bar").hidden=!(can && !dismissed);
}
async function doInstall(){
  if(!installEvt) return;
  installEvt.prompt();
  try{ const r=await installEvt.userChoice; if(r&&r.outcome==="accepted") toast("Instalando o app…"); }catch(e){}
  installEvt=null; showInstall();
}
window.addEventListener("beforeinstallprompt",e=>{ e.preventDefault(); installEvt=e; showInstall(); });
window.addEventListener("appinstalled",()=>{ installEvt=null; showInstall(); toast("App instalado. Abra pelo ícone Costura Expressa."); });
$("#install-go").addEventListener("click",doInstall);
$("#install-login").addEventListener("click",doInstall);
$("#install-x").addEventListener("click",()=>{ try{ localStorage.setItem("ce-install-x",String(Date.now())); }catch(e){} $("#install-bar").hidden=true; });
if("serviceWorker" in navigator && window.isSecureContext){
  window.addEventListener("load",()=>{ navigator.serviceWorker.register("sw.js").catch(e=>console.warn("SW",e)); });
  let swReload=false; const hadCtrl=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange",()=>{ if(!hadCtrl || swReload) return; swReload=true; if($("#overlay").hidden && !saving) location.reload(); });
}
$("#dev-out").addEventListener("click",async()=>{
  const b=$("#dev-out");
  if(!b.classList.contains("armed")){ b.classList.add("armed"); b.textContent="Toque de novo para desconectar"; setTimeout(()=>{ b.classList.remove("armed"); b.textContent="Desconectar este aparelho"; },5000); return; }
  try{ ls.set("ce-sess",""); if(window.firebase&&firebase.apps&&firebase.apps.length) await firebase.auth().signOut(); }catch(e){}
  location.reload();
});

/* ---------- entrega ---------- */
let entregaTipo="retirada";
function telCompleto(){
  const raw=$("#c-tel").value.trim(); if(!raw) return "";
  if(raw.startsWith("+")) return raw;
  const ddi=$("#c-ddi").value;
  if(ddi==="+55" || ddi==="+") return ddi==="+"?("+"+raw.replace(/^\+/,"")):raw;
  return ddi+" "+raw;
}
let prioNovo=false;
function setPrioNovo(v){ prioNovo=v; const b=$("#c-prio"); b.setAttribute("aria-pressed",String(v)); b.textContent = v ? "★ Pedido prioritário (toque para tirar)" : "★ Marcar como prioridade"; }
$("#c-prio").addEventListener("click",()=>setPrioNovo(!prioNovo));
function setEntrega(v){ entregaTipo=v; $("#et-ret").setAttribute("aria-pressed",String(v==="retirada")); $("#et-ent").setAttribute("aria-pressed",String(v==="entrega"));
  $("#f-end").hidden = v!=="entrega";
  if(v==="entrega" && !$("#c-end").value.trim()){ const c=clientes.get(telKey(telCompleto())); if(c&&c.endereco) $("#c-end").value=U(c.endereco); }
  if(v==="entrega") setTimeout(()=>$("#c-end").focus(),50); }
$("#et-ret").addEventListener("click",()=>setEntrega("retirada"));
$("#et-ent").addEventListener("click",()=>setEntrega("entrega"));
const comEntrega=o=>o.entregaTipo==="entrega";
const ondePaga=o=>comEntrega(o)?"na entrega":"na retirada";

/* ---------- clientes: encontrar pelo telefone ---------- */
const clientes=new Map(); // chave: número completo (55+DDD+número)
let autoNome="";
function telKey(tel){ const n=waNumber(tel); return n && n.length>=12 ? n : ""; }
function findCliente(tel){
  const k=telKey(tel); if(!k) return null;
  const doc=clientes.get(k);
  const ped=orders.filter(o=>telKey((o.cliente||{}).telefone)===k).sort((a,b)=>(b.criadoEm||0)-(a.criadoEm||0));
  if(!doc && !ped.length) return null;
  return { nome: U(doc&&doc.nome || (ped[0].cliente||{}).nome || ""), pedidos: ped.length, ultimo: ped[0]||null };
}
function checkCliente(){
  const tel=telCompleto(), box=$("#c-found"), nomeEl=$("#c-nome");
  if(!telKey(tel)){ box.hidden=true; if(autoNome && nomeEl.value===autoNome){ nomeEl.value=""; } autoNome=""; return; }
  const c=findCliente(tel);
  if(!c||!c.nome){ box.hidden=false; box.className="found new"; box.textContent="Cliente nova: digite o nome abaixo."; if(autoNome && nomeEl.value===autoNome) nomeEl.value=""; autoNome=""; return; }
  box.hidden=false; box.className="found";
  const info=c.pedidos?` · ${c.pedidos} pedido${c.pedidos>1?"s":""}${c.ultimo?", o último em "+fmtDate(c.ultimo.criadoEm).slice(0,10):""}`:"";
  const vazio=!nomeEl.value.trim() || nomeEl.value===autoNome;
  const endSalvo=(clientes.get(telKey(tel))||{}).endereco;
  if(endSalvo && entregaTipo==="entrega" && !$("#c-end").value.trim()) $("#c-end").value=U(endSalvo);
  if(vazio){ nomeEl.value=c.nome; autoNome=c.nome; box.innerHTML=`Cliente encontrada: <b>${esc(c.nome)}</b>${info}`; }
  else if(U(nomeEl.value.trim())!==c.nome){ box.innerHTML=`Este telefone é de <b>${esc(c.nome)}</b>${info}. <button class="btn" type="button" id="c-usar">Usar este nome</button>`;
    $("#c-usar").onclick=()=>{ nomeEl.value=c.nome; autoNome=c.nome; checkCliente(); }; }
  else box.innerHTML=`Cliente encontrada: <b>${esc(c.nome)}</b>${info}`;
}
$("#c-tel").addEventListener("input",checkCliente);
$("#c-ddi").addEventListener("change",()=>{ const v=$("#c-ddi").value;
  $("#c-tel").placeholder = v==="+55" ? "(81) 9 9999-9999" : v==="+" ? "+ código do país e número" : "número com código de área";
  $("#c-tel-hint").hidden = v!=="+"; checkCliente(); $("#c-tel").focus(); });
$("#c-nome").addEventListener("input",()=>{ if($("#c-nome").value!==autoNome) autoNome=""; });
async function saveCliente(nome,tel,endereco){
  const k=telKey(tel); if(!k||!nome||!db) return;
  const ant=clientes.get(k)||{};
  try{ await db.doc(`clientes/${k}`).set({nome:U(nome), telefone:String(tel).trim(), endereco:U(endereco||ant.endereco||""), atualizadoEm:Date.now()}); }catch(e){ console.warn(e); }
}

/* ---------- tudo em maiúsculo ---------- */
const NO_UPPER=new Set(["app-link","m-pin","dev-email","dev-pass","lg-pin","code-in"]);
function upperable(el){
  if(!el || el.readOnly) return false;
  if(el.tagName==="TEXTAREA") return true;
  if(el.tagName!=="INPUT") return false;
  if(!["text","search",""].includes(el.type)) return false;
  if(NO_UPPER.has(el.id) || /^pe-/.test(el.id) || el.inputMode==="numeric") return false;
  return true;
}
document.addEventListener("input",e=>{
  const el=e.target; if(!upperable(el) || e.isComposing) return;
  const v=el.value, u=v.toLocaleUpperCase("pt-BR"); if(v===u) return;
  const a=el.selectionStart, b=el.selectionEnd; el.value=u;
  try{ el.setSelectionRange(a,b); }catch(_){}
},true);
const U=t=>String(t??"").toLocaleUpperCase("pt-BR");

/* ---------- inicialização ---------- */
renderPick(); renderTabela(); renderPhotos(); renderAudio(); renderRecent(); renderQueue(); renderLogi(); renderEntregues(); renderCaixa(); renderProducao(); renderPedidos(); renderClientes(); renderFaturamento(); renderDespesas(); renderDoDia(); if(curView==="menu") renderMenu(); renderSvcEdit();
const hashCode = extractCode(decodeURIComponent(location.hash||""));
let ordersLoaded=false, hashOpened=false;
const offT=setTimeout(()=>{ if(!db) $("#offline").hidden=false; },4000);

(async()=>{
  const cfg=window.FIREBASE_CONFIG;
  const fail=t=>{ clearTimeout(offT); $("#offline").hidden=false; $("#offline").textContent=t; $("#login-body").innerHTML=`<p>${t}</p>`; };
  if(!window.firebase || !cfg || !cfg.apiKey || String(cfg.apiKey).startsWith("COLE")){
    try{ db=await localDB(); }catch(e){ console.error(e); fail("Este navegador não permite salvar dados. Abra o site no Chrome ou no Safari, fora da aba anônima."); return; }
    clearTimeout(offT); const b=$("#offline"); b.hidden=false;
    b.textContent="Modo de um aparelho: os pedidos ficam salvos só neste celular ou computador.";
    renderLogin(); startData(); return;
  }
  let user=null;
  try{
    firebase.initializeApp(cfg);
    user=await new Promise(res=>{ const un=firebase.auth().onAuthStateChanged(u=>{ un(); res(u); }); });
  }catch(e){ console.error(e); fail("Não foi possível conectar ao banco do ateliê. Verifique a internet e recarregue a página."); return; }
  clearTimeout(offT); $("#offline").hidden=true;
  if(user && user.isAnonymous){ try{ await firebase.auth().signOut(); }catch(e){} user=null; }
  if(!user){ renderDeviceLogin(); return; }
  connectDB();
})();
function connectDB(){
  db=firebase.firestore();
  try{ db.enablePersistence({synchronizeTabs:true}).catch(()=>{}); }catch(e){}
  renderLogin(); startData();
}
function renderDeviceLogin(err){
  $("#login-body").innerHTML=`<form class="grp" id="dev-form" style="gap:14px" autocomplete="on">
    <h2>Entrar no ateliê</h2>
    <p>Este aparelho ainda não está liberado. Use o e-mail e a senha do ateliê. Isso é feito uma vez só em cada celular ou computador.</p>
    <div class="field"><label for="dev-email">E-mail do ateliê</label><input type="email" id="dev-email" autocomplete="username" inputmode="email" required></div>
    <div class="field"><label for="dev-pass">Senha do ateliê</label><input type="password" id="dev-pass" autocomplete="current-password" required></div>
    ${err?`<div class="err">${esc(err)}</div>`:""}
    <button class="btn primary" id="dev-go" type="submit">Liberar este aparelho</button>
  </form>`;
  $("#dev-form").addEventListener("submit",async e=>{
    e.preventDefault(); const btn=$("#dev-go"); btn.disabled=true; btn.textContent="Entrando…";
    try{
      await firebase.auth().signInWithEmailAndPassword($("#dev-email").value.trim(), $("#dev-pass").value);
      connectDB();
    }catch(e){
      const c=e&&e.code||"";
      const m = /invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(c) ? "E-mail ou senha incorretos."
        : /too-many-requests/.test(c) ? "Muitas tentativas. Espere alguns minutos e tente de novo."
        : /network/.test(c) ? "Sem internet. Verifique a conexão." : "Não foi possível entrar ("+c+").";
      renderDeviceLogin(m);
    }
  });
}
function startData(){
  db.collection("equipe").onSnapshot(s=>{
    team=s.docs.map(d=>({id:d.id,...d.data()})); teamLoaded=true;
    const saved=ls.get("ce-sess","");
    if(session){ const m=team.find(x=>x.id===session.id); if(!m) logout(); else if(m.papel!==session.papel||m.nome!==session.nome) startSession({id:m.id,nome:m.nome,papel:m.papel}); }
    else if(!session && saved){ const m=team.find(x=>x.id===saved); if(m) startSession({id:m.id,nome:m.nome,papel:m.papel});  }
    if(!session) renderLogin();
    renderTeam(); renderLogi(); renderProducao();
  }, e=>console.error(e));
  db.collection("despesas").onSnapshot(s=>{ despesas=s.docs.map(d=>({id:d.id,...d.data()})); renderDespesas(); renderFaturamento(); }, e=>console.warn(e));
  db.collection("clientes").onSnapshot(s=>{ clientes.clear(); s.docs.forEach(d=>clientes.set(d.id,d.data())); if(telKey(telCompleto())) checkCliente(); renderClientes(); if(curView==="menu") renderMenu(); }, e=>console.warn(e));
  db.collection("servicos").orderBy("nome").onSnapshot(s=>{
    services=s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.nome).localeCompare(String(b.nome),"pt-BR"));
    Object.keys(cart).forEach(k=>{ if(!services.find(x=>x.id===k)) delete cart[k]; });
    renderPick(); renderSvcEdit();
  }, e=>console.error(e));
  let first=true;
  db.collection("pedidos").orderBy("criadoEm","desc").limit(1000).onSnapshot(s=>{
    orders=s.docs.map(d=>d.data());
    renderRecent(); renderQueue(); renderLogi(); renderEntregues(); renderCaixa(); renderProducao(); renderPedidos(); renderClientes(); renderFaturamento(); renderDespesas(); renderDoDia(); if(curView==="menu") renderMenu();
    if(openCode){ const o=orders.find(x=>x.codigo===openCode); if(o && !editing && (o.historico||[]).length!==sheetKey) renderSheet(o); }
    if(first){ first=false; ordersLoaded=true; if(hashCode && session && !hashOpened){ hashOpened=true; openOrder(hashCode); } }
  }, e=>console.error(e));
}
})();
