  /* ---------- DB layer: which block writes which record and field, and who reads it (data: db-layer/db-layer.json, inserted at build) ---------- */
  var DBL=/*@DBLAYER@*/null;
  var dbOn=false,dbEl={},dbBox={},dbGrpEl={},dbHeadEl=null,dbDrawn=[],dbF={w:[],r:[],k:"",g:"",path:false,focus:"",field:""};
  var DBW="var(--accent)",DBR="var(--db4)";  /* click mode: writes vs reads */
  var DBC=["var(--accent)","var(--ok)","var(--warn)","var(--db4)"];
  try{var dbs=JSON.parse(localStorage.getItem(KEY+"-db")||"null");if(dbs){dbOn=!!dbs.on;dbF.g=dbs.g||"";}}catch(_){}
  function dbSave(){try{localStorage.setItem(KEY+"-db",JSON.stringify({on:dbOn,g:dbF.g}));}catch(_){}}
  function dbKindOn(k){return (!k.proposed||DISC==="new")&&(!dbF.g||k.group===dbF.g);}
  function dbUnder(nodeKey,sel){return nodeKey===sel||nodeKey.indexOf(sel+".")===0;}
  function dbLabel(key){var parts=key.split("."),cur="",out=[];
    for(var i=0;i<parts.length;i++){cur=cur?cur+"."+parts[i]:parts[i];if(IT[cur])out.push(IT[cur].t);else return key+" (?)";}
    return out.join(" · ");}
  function dbShortFields(arr){if(!arr||!arr.length)return "";var s=arr.slice(0,3).join(", ");return arr.length>3?s+" …":s;}
  function dbActive(){return dbOn&&(dbF.w.length||dbF.r.length||dbF.k||dbF.focus);}
  /* a field picked in the record card narrows lines to entries touching that field (same top-level key or nested) */
  function dbFieldHit(en){if(!dbF.field)return true;var top=dbF.field.split(".")[0];
    return (en.fields||[]).some(function(f){return f===dbF.field||dbF.field.indexOf(f+".")===0||f.indexOf(dbF.field+".")===0||f.split(".")[0]===top;});}
  function dbClear(){dbF.focus="";dbF.k="";dbF.field="";var sk=document.getElementById("dbK");if(sk)sk.value="";}
  function dbBuild(){
    if(!DBL)return;
    dbHeadEl=document.createElement("div");dbHeadEl.className="dbhead";dbHeadEl.hidden=true;
    var h='<div class="ht">state.sqlite · база проекта</div><div class="hs">Записи только добавляются: каждая версия — строка <code>revisions</code>; <code>heads</code> — последняя версия; <code>events</code> — порядок. Всё содержимое записи — JSON в колонке <code>body</code>.</div><div class="tb">';
    (DBL.tables||[]).forEach(function(t){h+='<div><b>'+esc(t.name)+'</b><span>'+esc(t.note||"")+'</span></div>';});
    h+='</div>';dbHeadEl.innerHTML=h;view.appendChild(dbHeadEl);
    (DBL.groups||[]).forEach(function(g){var f=document.createElement("div");f.className="dbgrp";f.hidden=true;f.innerHTML='<span class="gt">'+esc(g.t)+'</span>';view.appendChild(f);dbGrpEl[g.id]=f;});
    DBL.kinds.forEach(function(k){
      var d=document.createElement("div");d.className="dbk"+(k.proposed?" prop":"");d.dataset.kind=k.kind;d.tabIndex=0;d.setAttribute("role","button");d.hidden=true;
      d.setAttribute("aria-label","Запись "+k.kind);
      d.innerHTML='<div class="kh"><span class="pill">'+(k.proposed?"предложение":"запись")+'</span><span class="kw">✎ '+(k.writers||[]).length+' · ◉ '+(k.readers||[]).length+'</span></div>'+
        '<div class="kn">'+esc(k.kind)+'</div><div class="ki">'+esc(k.idPattern||"")+'</div>'+
        (k.card&&k.card.what?'<div class="kt">'+esc(k.card.what)+'</div>':'')+
        (k.card&&k.card.size?'<div class="kc">'+esc(k.card.size)+'</div>':'');
      view.appendChild(d);dbEl[k.kind]=d;
    });
  }
  /* band under the pipeline: header with tables, then one column block per group */
  function dbLayout(bottom){
    dbBox={};
    if(!DBL)return;
    var show=dbOn;
    dbHeadEl.hidden=!show;
    Object.keys(dbGrpEl).forEach(function(g){dbGrpEl[g].hidden=true;});
    DBL.kinds.forEach(function(k){dbEl[k.kind].hidden=!(show&&dbKindOn(k));});
    if(!show)return;
    var y0=bottom+340,x=40;
    dbHeadEl.style.left=x+"px";dbHeadEl.style.top=y0+"px";x+=dbHeadEl.offsetWidth+70;
    (DBL.groups||[]).forEach(function(g){
      var ks=DBL.kinds.filter(function(k){return k.group===g.id&&dbKindOn(k);});
      if(!ks.length)return;
      var per=7,cols=Math.ceil(ks.length/per),W=226,colH=[],gx=x+18,gy=y0+40;
      for(var c=0;c<cols;c++)colH.push(gy);
      ks.forEach(function(k,i){var c=Math.floor(i/per),el=dbEl[k.kind];
        el.style.left=(gx+c*W)+"px";el.style.top=colH[c]+"px";
        dbBox[k.kind]={x:gx+c*W,y:colH[c],w:el.offsetWidth,h:el.offsetHeight};colH[c]+=el.offsetHeight+14;});
      var fh=Math.max.apply(null,colH)-y0+10,fw=cols*W+24,f=dbGrpEl[g.id];
      f.hidden=false;f.style.left=x+"px";f.style.top=y0+"px";f.style.width=fw+"px";f.style.height=fh+"px";
      dbBox["grp:"+g.id]={x:x,y:y0,w:fw,h:fh};
      x+=fw+60;
    });
    dbBox["head"]={x:40,y:y0,w:dbHeadEl.offsetWidth,h:dbHeadEl.offsetHeight};
  }
  function dbBounds(b){if(!dbOn)return b;Object.keys(dbBox).forEach(function(k){var p=dbBox[k];
    var x1=Math.max(b.x+b.w,p.x+p.w),y1=Math.max(b.y+b.h,p.y+p.h);b.x=Math.min(b.x,p.x);b.y=Math.min(b.y,p.y);b.w=x1-b.x;b.h=y1-b.y;});return b;}
  /* lines: solid = writes, dashed = reads; colour = selected writer/reader */
  function dbLine(a,b,up,color,label,dashed){
    var e=up?{fs:"t",ts:"b",ff:.5,tf:.5}:{fs:"b",ts:"t",ff:.5,tf:.5};
    var p=document.createElementNS(NSV,"path");p.setAttribute("d",curve(a,b,e));p.setAttribute("class","e db"+(dashed?" rd":""));
    p.style.stroke=color;svg.appendChild(p);
    var len=p.getTotalLength(),pt=p.getPointAtLength(len*(up?.35:.65));
    var lb=document.createElement("div");lb.className="lbl db";lb.textContent=label||"";lb.hidden=!label;lb.style.left=pt.x+"px";lb.style.top=pt.y+"px";lb.style.borderColor=color;view.appendChild(lb);
    dbDrawn.push({p:p,lb:lb});
  }
  function dbEdges(){
    dbDrawn.forEach(function(d){d.p.remove();d.lb.remove();});dbDrawn=[];
    if(!DBL||!dbActive())return;
    var seen={};
    function nodeBox(key){var r=resolve(key);return shown(r)?{key:r,b:box(elOf(r))}:null;}
    function draw(kind,ent,isW,color,dashed){
      if(!dbBox[kind])return;var nb=nodeBox(ent.node);if(!nb)return;
      var id=(isW?"w":"r")+nb.key+">"+kind+color;if(seen[id])return;seen[id]=1;
      if(isW)dbLine(nb.b,dbBox[kind],false,color,(isW?"пишет: ":"")+dbShortFields(ent.fields),false);
      else dbLine(dbBox[kind],nb.b,true,color,"читает: "+dbShortFields(ent.fields),true);
    }
    var kinds=DBL.kinds.filter(dbKindOn);
    dbF.w.forEach(function(w,i){kinds.forEach(function(k){(k.writers||[]).forEach(function(en){if(dbUnder(en.node,w))draw(k.kind,en,true,DBC[i],false);});
      if(dbF.path)(k.writers||[]).some(function(en){return dbUnder(en.node,w);})&&(k.readers||[]).forEach(function(en){draw(k.kind,en,false,DBC[i],true);});});});
    dbF.r.forEach(function(r,i){kinds.forEach(function(k){(k.readers||[]).forEach(function(en){if(dbUnder(en.node,r))draw(k.kind,en,false,DBC[i],true);});
      if(dbF.path)(k.readers||[]).some(function(en){return dbUnder(en.node,r);})&&(k.writers||[]).forEach(function(en){draw(k.kind,en,true,DBC[i],false);});});});
    if(dbF.focus)kinds.forEach(function(k){
      (k.writers||[]).forEach(function(en){if(dbUnder(en.node,dbF.focus))draw(k.kind,en,true,DBW,false);});
      (k.readers||[]).forEach(function(en){if(dbUnder(en.node,dbF.focus))draw(k.kind,en,false,DBR,true);});});
    if(dbF.k){var k=DBL.kinds.filter(function(x){return x.kind===dbF.k;})[0];
      if(k){(k.writers||[]).filter(dbFieldHit).forEach(function(en){draw(k.kind,en,true,DBW,false);});(k.readers||[]).filter(dbFieldHit).forEach(function(en){draw(k.kind,en,false,DBR,true);});
        if(dbF.path)(k.readers||[]).forEach(function(rd){kinds.forEach(function(k2){(k2.writers||[]).forEach(function(en){if(dbUnder(en.node,rd.node)||dbUnder(rd.node,en.node))draw(k2.kind,en,true,DBC[2],false);});});});}}
  }
  /* highlight: involved blocks and records stay lit, the rest fades */
  function dbApply(){
    DBL&&DBL.kinds.forEach(function(k){dbEl[k.kind].classList.remove("on","dim");});
    if(!dbActive())return;
    var lit={},klit={};
    function mark(node){var r=resolve(node);lit[r]=1;}
    var kinds=DBL.kinds.filter(dbKindOn);
    if(dbF.focus){lit[resolve(dbF.focus)]=1;kinds.forEach(function(k){
      (k.writers||[]).forEach(function(en){if(dbUnder(en.node,dbF.focus)){klit[k.kind]=1;mark(en.node);}});
      (k.readers||[]).forEach(function(en){if(dbUnder(en.node,dbF.focus)){klit[k.kind]=1;mark(en.node);}});});}
    if(dbF.k){klit[dbF.k]=1;var kk=DBL.kinds.filter(function(x){return x.kind===dbF.k;})[0];
      if(kk){(kk.writers||[]).filter(dbFieldHit).forEach(function(en){mark(en.node);});(kk.readers||[]).filter(dbFieldHit).forEach(function(en){mark(en.node);});}}
    kinds.forEach(function(k){
      var hitW=(k.writers||[]).some(function(en){return dbF.w.some(function(w){return dbUnder(en.node,w);});});
      var hitR=(k.readers||[]).some(function(en){return dbF.r.some(function(r){return dbUnder(en.node,r);});});
      if(hitW||hitR){klit[k.kind]=1;
        if(dbF.path){(k.writers||[]).forEach(function(en){mark(en.node);});(k.readers||[]).forEach(function(en){mark(en.node);});}
        else{(k.writers||[]).forEach(function(en){if(dbF.w.some(function(w){return dbUnder(en.node,w);}))mark(en.node);});
          (k.readers||[]).forEach(function(en){if(dbF.r.some(function(r){return dbUnder(en.node,r);}))mark(en.node);});}}
    });
    visibleKeys().forEach(function(k){var el=elOf(k);el.classList.toggle("near",!!lit[k]&&k!==sel);el.classList.toggle("dim",!lit[k]&&k!==sel);el.classList.toggle("on",k===sel);});
    drawn.forEach(function(d){d.p.classList.add("dim");d.lb.classList.add("dim");});
    kinds.forEach(function(k){dbEl[k.kind].classList.toggle("on",!!klit[k.kind]);dbEl[k.kind].classList.toggle("dim",!klit[k.kind]);});
  }
  /* detail: the record with its standard set — what, where, who writes, when, why, who reads and expects, risks, size */
  function dbRow(t,v,cls){return v?'<div><dt>'+esc(t)+'</dt><dd'+(cls?' class="'+cls+'"':'')+'>'+esc(v)+'</dd></div>':'';}
  function openDbDetail(kind){
    var k=DBL.kinds.filter(function(x){return x.kind===kind;})[0];if(!k)return;
    sel=null;var c=k.card||{};dbF.focus="";if(dbF.k!==kind){dbF.k=kind;dbF.field="";}var sk=document.getElementById("dbK");if(sk)sk.value=kind;
    var h='<div class="top"><span class="pill acc">'+(k.proposed?"предложение":"запись")+'</span><span class="pill">'+esc((DBL.groups.filter(function(g){return g.id===k.group;})[0]||{}).t||k.group)+'</span>'+
      '<button type="button" class="x" data-act="close" aria-label="Закрыть">×</button></div><h2 class="mono">'+esc(k.kind)+'</h2><div class="io">'+esc(k.idPattern||"")+'</div><dl>'+
      dbRow("Что",c.what)+dbRow("Где",c.where)+dbRow("Когда",c.when)+dbRow("Зачем",c.why)+dbRow("Что ожидают читатели",c.expects)+dbRow("Риски",c.risks,"gap")+dbRow("Сколько",c.size)+'</dl>';
    h+='<div class="dbsec">Пишут ('+(k.writers||[]).length+')</div>';
    (k.writers||[]).forEach(function(en){h+='<button type="button" class="dbln" data-go="'+esc(resolve(en.node))+'"><b>'+esc(dbLabel(en.node))+'</b><i>'+esc(en.code||"")+(en.sure===false?' · не проверено':'')+'</i>'+
      (en.when?'<span>когда: '+esc(en.when)+'</span>':'')+(en.fields&&en.fields.length?'<span>поля: '+esc(en.fields.join(", "))+'</span>':'')+'</button>';});
    h+='<div class="dbsec">Читают ('+(k.readers||[]).length+')</div>';
    (k.readers||[]).forEach(function(en){h+='<button type="button" class="dbln" data-go="'+esc(resolve(en.node))+'"><b>'+esc(dbLabel(en.node))+'</b><i>'+esc(en.code||"")+(en.sure===false?' · не проверено':'')+'</i>'+
      (en.fields&&en.fields.length?'<span>поля: '+esc(en.fields.join(", "))+'</span>':'')+(en.expects?'<span>ожидает: '+esc(en.expects)+'</span>':'')+'</button>';});
    var fs=k.fields||[];
    if(fs.length){h+='<div class="dbsec">Поля ('+fs.length+') · ★ — стык между блоками</div>';
      fs.forEach(function(f){
        var fsel=dbF.field===f.path?' sel':'';
        if(f.iface)h+='<details class="dbf'+fsel+'"><summary><b>★ '+esc(f.path)+'</b><i>'+esc(f.type||"")+'</i><button type="button" class="fl" data-dbfield="'+esc(f.path)+'">стрелки поля</button></summary><dl>'+dbRow("Что",f.what)+dbRow("Кто пишет",f.writer)+dbRow("Кто читает",f.readers)+dbRow("Что ожидают",f.expects)+dbRow("Риски",f.risks,"gap")+'</dl></details>';
        else h+='<div class="dbf'+fsel+'"><b>'+esc(f.path)+'</b><i>'+esc(f.type||"")+'</i><button type="button" class="fl" data-dbfield="'+esc(f.path)+'">стрелки поля</button>'+(f.what?'<span>'+esc(f.what)+'</span>':'')+'</div>';});}
    h+='<div class="dbleg"><span style="color:var(--accent)">━ пишет</span><span style="color:var(--db4)">┅ читает</span>'+(dbF.field?'<button type="button" class="fl" data-dbfield="">все поля</button><span>поле: '+esc(dbF.field)+'</span>':'')+'</div>';
    var keep=detail.scrollTop,same=detail.dataset.kind===kind;detail.dataset.kind=kind;
    detail.innerHTML=h;detail.hidden=false;detail.scrollTop=same?keep:0;dbEdges();apply();
    DBL.kinds.forEach(function(x){dbEl[x.kind].classList.toggle("on",x.kind===kind);});
  }
  function dbNodeInfo(key){
    if(!DBL)return "";var w=[],r=[];
    DBL.kinds.forEach(function(k){if((k.writers||[]).some(function(en){return dbUnder(en.node,key);}))w.push(k.kind);if((k.readers||[]).some(function(en){return dbUnder(en.node,key);}))r.push(k.kind);});
    if(!w.length&&!r.length)return "";
    var h='<div class="links">';
    w.forEach(function(k){h+='<button type="button" data-dbk="'+esc(k)+'"><i>✎ пишет в базу</i>'+esc(k)+'</button>';});
    r.forEach(function(k){h+='<button type="button" data-dbk="'+esc(k)+'"><i>◉ читает из базы</i>'+esc(k)+'</button>';});
    return h+'</div>';
  }
  /* filter bar */
  var dbBar=document.getElementById("dbbar"),dbT=document.getElementById("dbT");
  function dbOpts(){
    if(!DBL)return;
    var ws={},rs={};DBL.kinds.forEach(function(k){(k.writers||[]).forEach(function(en){ws[en.node]=1;});(k.readers||[]).forEach(function(en){rs[en.node]=1;});});
    /* every listed node also offers its stage and sub-block, so a whole block can be picked at once */
    function fill(id,set,first){var s=document.getElementById(id),all={};s.innerHTML='<option value="">'+first+'</option>';
      Object.keys(set).forEach(function(n){var parts=n.split("."),cur="";parts.forEach(function(p){cur=cur?cur+"."+p:p;if(IT[cur])all[cur]=1;});all[n]=1;});
      Object.keys(all).sort(function(a,b){var ia=ORDER.indexOf(a),ib=ORDER.indexOf(b);return (ia<0?1e9:ia)-(ib<0?1e9:ib);}).forEach(function(n){
        var o=document.createElement("option");o.value=n;var it=IT[n],depth=n.split(".").length-1;
        o.textContent=(depth?"\u00a0\u00a0".repeat(depth):"")+(it&&it.kind!=="node"?"▸ "+(it.n?it.n+" · ":"")+it.t+" (весь блок)":(it?it.t:n+" (?)"));s.appendChild(o);});}
    fill("dbW",ws,"+ писатель…");fill("dbR",rs,"+ читатель…");
    var sk=document.getElementById("dbK");sk.innerHTML='<option value="">запись: все</option>';
    DBL.kinds.forEach(function(k){var o=document.createElement("option");o.value=k.kind;o.textContent=k.kind;sk.appendChild(o);});
    var sg=document.getElementById("dbG");sg.innerHTML='<option value="">стадия: все</option>';
    (DBL.groups||[]).forEach(function(g){var o=document.createElement("option");o.value=g.id;o.textContent=g.t;if(g.id===dbF.g)o.selected=true;sg.appendChild(o);});
  }
  function dbChips(){
    function render(id,arr,cls){var box=document.getElementById(id);box.innerHTML="";
      arr.forEach(function(n,i){var b=document.createElement("button");b.type="button";b.className="chip dbsel";b.dataset[cls]=n;b.style.borderColor=DBC[i];b.style.color=DBC[i];
        b.textContent=(cls==="rmw"?"✎ ":"◉ ")+dbLabel(n).split(" · ").slice(-2).join(" · ")+" ×";b.title=dbLabel(n);box.appendChild(b);});}
    render("dbWs",dbF.w,"rmw");render("dbRs",dbF.r,"rmr");
  }
  function dbRefresh(){dbChips();layout();}
  if(DBL&&dbBar){
    dbBuild();dbOpts();dbT.hidden=false;
    dbT.setAttribute("aria-pressed",dbOn?"true":"false");dbBar.hidden=!dbOn;
    dbT.addEventListener("click",function(){dbOn=!dbOn;dbT.setAttribute("aria-pressed",dbOn?"true":"false");dbBar.hidden=!dbOn;dbSave();layout();fit();});
    document.getElementById("dbW").addEventListener("change",function(e){var v=e.target.value;if(v&&dbF.w.indexOf(v)<0&&dbF.w.length<4)dbF.w.push(v);e.target.value="";dbRefresh();});
    document.getElementById("dbR").addEventListener("change",function(e){var v=e.target.value;if(v&&dbF.r.indexOf(v)<0&&dbF.r.length<4)dbF.r.push(v);e.target.value="";dbRefresh();});
    document.getElementById("dbK").addEventListener("change",function(e){dbF.k=e.target.value;dbF.field="";dbF.focus="";if(dbF.k)openDbDetail(dbF.k);else dbRefresh();});
    document.getElementById("dbG").addEventListener("change",function(e){dbF.g=e.target.value;dbSave();layout();fit();});
    document.getElementById("dbP").addEventListener("change",function(e){dbF.path=e.target.checked;dbRefresh();});
    document.getElementById("dbX").addEventListener("click",function(){dbF.w=[];dbF.r=[];dbF.k="";dbF.path=false;dbF.focus="";dbF.field="";document.getElementById("dbK").value="";document.getElementById("dbP").checked=false;dbRefresh();});
    dbBar.addEventListener("click",function(ev){var b=ev.target.closest("button");if(!b)return;
      if(b.dataset.rmw){dbF.w=dbF.w.filter(function(x){return x!==b.dataset.rmw;});dbRefresh();}
      if(b.dataset.rmr){dbF.r=dbF.r.filter(function(x){return x!==b.dataset.rmr;});dbRefresh();}});
    view.addEventListener("click",function(ev){var c=ev.target.closest(".dbk");if(c)openDbDetail(c.dataset.kind);});
    view.addEventListener("keydown",function(ev){if(ev.key!=="Enter"&&ev.key!==" ")return;var c=ev.target.closest(".dbk");if(c){ev.preventDefault();openDbDetail(c.dataset.kind);}});
    detail.addEventListener("click",function(ev){var b=ev.target.closest("button");if(!b)return;
      if(b.dataset.dbk)openDbDetail(b.dataset.dbk);
      if(b.dataset.dbfield!==undefined&&detail.dataset.kind){ev.preventDefault();dbF.field=b.dataset.dbfield;openDbDetail(detail.dataset.kind);}
      if(b.dataset.dbf){dbF.k=b.dataset.dbf;document.getElementById("dbK").value=dbF.k;if(!dbOn)dbT.click();else dbRefresh();}});
  }
