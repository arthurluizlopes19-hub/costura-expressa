if(window.top!==window.self){ try{ window.top.location.replace(window.self.location.href); }catch(e){ document.documentElement.innerHTML=""; } }
(function(){
  const app=document.getElementById("app");
  const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money=v=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(v)||0);
  const fmtDay=iso=>{ if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
  const fmtDate=ts=>{ const d=new Date(ts); return d.toLocaleDateString("pt-BR")+" "+d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); };
  const STATUS={recebido:"Recebido",em_costura:"Em costura",pronto:"Pronto para retirada",entregue:"Entregue"};
  const code=(new URLSearchParams(location.search).get("c")||"").toUpperCase().replace(/[^A-Z0-9-]/g,"");
  const falha=t=>{ app.innerHTML=`<div class="msg">${esc(t)}<br><br>Qualquer dúvida, fale com a gente no WhatsApp (81) 99616-0055.</div>`; };
  if(!/^CE-[A-Z0-9]{6}$/.test(code)){ falha("Não encontramos este pedido. Confira o link que você recebeu."); return; }
  function render(p){
    const rows=(p.itens||[]).map(i=>`<tr><td>${esc(i.nome)}${i.orcamento?` <span class="orc">· em orçamento</span>`:""}</td><td class="n">${i.qtd}×</td>${i.orcamento?`<td class="n orc" colspan="2">A ORÇAR</td>`:`<td class="n">${money(i.preco)}</td><td class="n">${money(i.preco*i.qtd)}</td>`}</tr>`).join("");
    let pag="";
    if(p.pagoNoAto) pag+=`<tr><td colspan="3" style="font-weight:500;color:var(--muted)">Pago no ato (${esc(p.pagamento)})</td><td class="n" style="font-weight:500">${money(p.entrada)}</td></tr>`;
    else {
      if(Number(p.entrada)) pag+=`<tr><td colspan="3" style="font-weight:500;color:var(--muted)">Sinal (${esc(p.pagamento)})</td><td class="n" style="font-weight:500">${money(p.entrada)}</td></tr>`;
      if(p.status==="entregue") pag+=`<tr><td colspan="3">Situação</td><td class="n">Quitado</td></tr>`;
      else if(p.restante>0.001) pag+=`<tr class="pay"><td colspan="3">A pagar ${esc(p.ondePaga)}</td><td class="n">${money(p.restante)}</td></tr>`;
    }
    app.innerHTML=`<div class="center"><span class="status ${esc(p.status)}">${esc(STATUS[p.status]||"")}</span></div>
    <article class="nota">
      <div class="head"><div><img src="logo-costura-expressa.png" alt="Costura Expressa"><div class="addr">Galeria Jaqueira Park Center<br>R. do Futuro, 913 · Graças · Recife/PE</div></div>
        <div class="meta">Nº<b>${esc(p.codigo)}</b>${p.criadoEm?fmtDate(p.criadoEm):""}</div></div>
      <dl><dt>Cliente</dt><dd>${esc(p.cliente)}</dd>
        <dt>${p.comEntrega?"Data da entrega":"Retirada prevista"}</dt><dd>${fmtDay(p.entrega)}</dd>
        <dt>Entrega</dt><dd>${p.comEntrega?"Entrega no endereço":"Retirada no ateliê"}</dd></dl>
      <table><thead><tr><th>Serviço</th><th class="n">Qtd</th><th class="n">Unit.</th><th class="n">Valor</th></tr></thead><tbody>${rows}</tbody>
        <tfoot>${p.desconto?`<tr><td colspan="3">Subtotal</td><td class="n">${money(p.subtotal)}</td></tr><tr class="disc"><td colspan="3">${esc(p.descontoLabel||"Desconto")}</td><td class="n">− ${money(p.desconto)}</td></tr>`:""}
        <tr><td colspan="3">Total</td><td class="n big">${money(p.total)}</td></tr>${pag}</tfoot></table>
      ${p.obs?`<div><div class="label">Observações</div><div class="obs">${esc(p.obs)}</div></div>`:""}
      <div class="code"><span class="label" style="margin:0">Código do pedido</span><b>${esc(p.codigo)}</b><span>Apresente este código para retirar a peça.</span></div>
      <div class="foot">WhatsApp (81) 99616-0055</div>
    </article>`;
  }
  (async()=>{
    try{
      if(!window.firebase || !window.FIREBASE_CONFIG){ falha("Não foi possível abrir o pedido agora."); return; }
      firebase.initializeApp(window.FIREBASE_CONFIG);
      const d=await firebase.firestore().doc(`publico/${code}`).get();
      if(!d.exists){ falha("Não encontramos este pedido. Confira o link que você recebeu."); return; }
      render(d.data());
    }catch(e){ console.error(e); falha("Não foi possível abrir o pedido agora. Tente de novo em alguns minutos."); }
  })();
})();
