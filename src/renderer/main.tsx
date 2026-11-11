import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { cnpjDigits, formatCnpj, isValidCnpj } from '../shared/cnpj.ts';
import { cpfDigits, formatCpf, isValidCpf } from '../shared/cpf.ts';
import { CPI_MIN_INTERVAL_SECONDS, CPI_MAX_INTERVAL_SECONDS, parseCpiMonitorIntervalInput, getCpiRemainingSeconds, formatCpiCountdown } from '../shared/cpi-monitor-time.ts';
import type { AppSettings, QueryOutcome, HistoryEntry, QueryExecution, PisQueryExecution, MaintenancePreview, CpiBrowserStatus, CpiHistoryOverview, CpiPendingRowId, CpiAutoSnapshot } from '../shared/types.ts';
import { loadRememberedLogin } from './ux.ts';
import { Icon, ToastHost, type Notification } from './ui.tsx';
import './styles.css';

const DATASET_LABELS=['Dados básicos','Telefones','Endereços','E-mails','Processos judiciais'];
const defaultSettings:AppSettings={outputFolder:null,paidQueriesApproved:false};
function reportFilename(path:string):string { return path.split(/[\\/]/).pop() ?? path; }
function App(){
  const [tab,setTab]=useState<'acesso'|'consultar'|'pis'|'company'|'cpi'|'configurar'>('acesso');
  const [settings,setSettings]=useState<AppSettings>(defaultSettings);
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [remember,setRemember]=useState(false);
  const [hasSavedCredentials,setHasSavedCredentials]=useState(false);
  const [logged,setLogged]=useState(false);
  const [creditBalance,setCreditBalance]=useState<number|null>(null);
  const [cpf,setCpf]=useState('');
  const [pisCpf,setPisCpf]=useState('');
  const [cnpj,setCnpj]=useState('');
  const [companyEntries,setCompanyEntries]=useState<HistoryEntry[]>([]);
  const [pisEntries,setPisEntries]=useState<HistoryEntry[]>([]);
  const [busy,setBusy]=useState(false);
  const [cpiStatus,setCpiStatus]=useState<CpiBrowserStatus>({state:'closed'});
  const [cpiAuto,setCpiAuto]=useState<CpiAutoSnapshot|null>(null);
  const [cpiHistory,setCpiHistory]=useState<CpiHistoryOverview|null>(null);
  const [cpiIntervalInput,setCpiIntervalInput]=useState('60');
  const [cpiClockMs,setCpiClockMs]=useState(()=>Date.now());
  const [notice,setNotice]=useState<Notification|null>(null);
  const nextNoticeId=useRef(0);
  const credentialsEdited=useRef(false);
  const dismissNotice=useCallback(()=>setNotice(null),[]);
  const [last,setLast]=useState<QueryOutcome|null>(null);
  const [historyEntries,setHistoryEntries]=useState<HistoryEntry[]>([]);
  const [recoveryCode,setRecoveryCode]=useState('');
  const [hasReport,setHasReport]=useState(false);
  const [canReprocess,setCanReprocess]=useState(false);
  const [cleanupPreview,setCleanupPreview]=useState<MaintenancePreview|null>(null);
  const [backupInfo,setBackupInfo]=useState<string|null>(null);
  const [removePdfs,setRemovePdfs]=useState(false);
  const [removeHistory,setRemoveHistory]=useState(false);
  useEffect(()=>{
    let active=true;
    void window.deskdata.getSettings().then(value=>{if(active)setSettings(value);}).catch(()=>{if(active)show('Não foi possível ler as configurações locais.','error');});
    void loadRememberedLogin(window.deskdata).then(saved=>{
      if(!active)return;
      setHasSavedCredentials(Boolean(saved));
      if(saved&&!credentialsEdited.current){
        setUsername(saved.email);
        setPassword(saved.password);
        setRemember(true);
      }
    }).catch(()=>{
      if(!active)return;
      void window.deskdata.credentialsStatus().then(status=>{
        if(active)setHasSavedCredentials(status.hasSaved);
      }).catch(()=>{});
      show('As credenciais salvas não puderam ser recuperadas. Digite os dados ou use Esquecer para limpar o registro.','error');
    });
    return ()=>{active=false;};
  },[]);
  function showExecution(result:QueryExecution,label:string):void{
    if(result.state==='pending'){
      show(`Consulta ${label} registrada (${result.queryCode}). Recuperação automática em andamento; não inicie outra consulta.`, 'info');
      return;
    }
    setLast(result.pdf);
    if(label==='CPF'){setHasReport(true);setCanReprocess(false);}
    show(`PDF ${label} ${result.pdf.reused?'recuperado':'gerado'}: ${reportFilename(result.pdf.path)}`,'success');
  }
  function statusText(record:HistoryEntry):string{
    if(record.pdfPaths.length)return 'PDF disponível';
    if(record.status==='pending')return 'Em processamento · GET automático';
    if(record.status==='paused')return 'Recuperação pausada';
    return 'Pendente de verificação';
  }
  function historyAction(record:HistoryEntry){
    if(!record.queryCode)return null;
    if(record.status==='pending')return <span className="hint" aria-live="polite">Consultando automaticamente...</span>;
    if(record.status==='paused')return <button type="button" className="secondary" disabled={busy} onClick={()=>void resume(record.id)}>Retomar GET</button>;
    return <button type="button" className="secondary" disabled={busy} onClick={()=>void (record.kind==='company'?regenerateCompany(record.id):regenerate(record.id))}>Regerar PDF via GET</button>;
  }
  async function resume(recordId:string){await run(async()=>{
    const result=await window.deskdata.resumeQuery(recordId);
    showExecution(result,result.state==='pending'?'pendente':'recuperada');
    await refreshHistory();
  });}
  function show(text:string,type:'error'|'success'|'info'='info'):void{
    setNotice({id:++nextNoticeId.current,text,type});
  }
  useEffect(()=>{
    if(!logged)return;
    let active=true;
    const unsubscribe=window.deskdata.subscribeQueryUpdates(update=>{
      if(!active)return;
      void refreshHistory().then(()=>{
        if(!active)return;
        if(update.state==='ready')show('Consulta concluída e PDF gerado automaticamente. O arquivo está disponível no histórico.','success');
        else show(update.message??'Recuperação pausada. Use Retomar GET para continuar.','info');
      }).catch(()=>{});
    });
    return ()=>{active=false;unsubscribe();};
  },[logged]);
  async function refreshHistory(){
    const [people,pis,companies]=await Promise.all([window.deskdata.history(),window.deskdata.pisHistory(),window.deskdata.companyHistory()]);
    setHistoryEntries(people);setPisEntries(pis);setCompanyEntries(companies);
  }
  async function run(action:()=>Promise<void>):Promise<void>{
    if(busy)return;
    setBusy(true);dismissNotice();
    try{await action();}catch(error){show(error instanceof Error?error.message:'Operação não concluída.','error');}finally{setBusy(false);}
  }
  function login(event:FormEvent){event.preventDefault();void run(async()=>{
    const result=await window.deskdata.authenticate(username,password,remember);
    setLogged(true);setTab('acesso');setPassword('');
    setSettings(await window.deskdata.getSettings());
    await refreshHistory();
    if(result.remembered)setHasSavedCredentials(true);
    try{const balance=await window.deskdata.credits();setCreditBalance(balance);show(result.warning??'Sessão autenticada. Saldo consultado sem consumir datasets.',result.warning?'info':'success');}
    catch{setCreditBalance(null);show(result.warning??'Sessão autenticada, mas o saldo não pôde ser consultado.','info');}
  });}
  async function fillSaved(){await run(async()=>{
    const saved=await loadRememberedLogin(window.deskdata);
    if(!saved)throw new Error('Não existem credenciais salvas neste computador.');
    credentialsEdited.current=false;setUsername(saved.email);setPassword(saved.password);setRemember(true);
    show('Credenciais preenchidas. Clique em Autenticar para acessar a Deskdata.','info');
  });}
  async function forgetSaved(){await run(async()=>{
    await window.deskdata.forgetSavedCredentials();setHasSavedCredentials(false);setRemember(false);setUsername('');setPassword('');
    show('Credenciais salvas removidas deste computador.','success');
  });}
  useEffect(()=>{
    if(!logged || tab!=='configurar')return;
    let active=true;
    void window.deskdata.maintenancePreview().then(preview=>{if(active)setCleanupPreview(preview);}).catch(error=>{
      if(active)show(error instanceof Error?error.message:'Falha ao ler os registros locais.','error');
    });
    return ()=>{active=false;};
  },[logged,tab]);
  async function createBackup(){await run(async()=>{
    const result=await window.deskdata.createBackup();
    setBackupInfo(result.path);
    show('Backup protegido criado com sucesso.','success');
  });}
  async function openDiagnosticsFolder(){await run(async()=>{await window.deskdata.openDiagnosticsFolder();});}
  async function openBackupFolder(){await run(async()=>{
    await window.deskdata.openBackupFolder();
  });}
  async function cleanupLocal(){await run(async()=>{
    const result=await window.deskdata.cleanLocalData({pdfs:removePdfs,history:removeHistory});
    if(result.cancelled){show('Limpeza cancelada. Nenhum arquivo foi excluído.','info');return;}
    setCleanupPreview(await window.deskdata.maintenancePreview());
    await refreshHistory();
    setLast(null);setHasReport(false);setCanReprocess(false);
    setRemovePdfs(false);setRemoveHistory(false);
    show(`Limpeza concluída: ${result.deletedPdfs} PDF(s) excluído(s), ${result.deletedRecords} registro(s) removido(s)${result.missingPdfs?`, ${result.missingPdfs} arquivo(s) já ausente(s)`:''}.`,'success');
  });}
  function query(event:FormEvent){event.preventDefault();void run(async()=>{
    show('Consultando a Deskdata. A operação pode levar alguns minutos. Não a repita.');
    let pdfSaved = false;
    try {
      const result=await window.deskdata.queryAndSave(cpfDigits(cpf));
      pdfSaved = result.state==='ready';
      showExecution(result,'CPF');
      await refreshHistory();
    } finally {
      await refreshHistory();
      const state=await window.deskdata.recoveryStatus();
      setCanReprocess(!pdfSaved && state.hasResponse);
      setHasReport(state.hasReport);
      try{setCreditBalance(await window.deskdata.credits());}catch{setCreditBalance(null);}
    }
  });}
  async function folder(){await run(async()=>{setSettings(await window.deskdata.chooseFolder());show('Destino dos relatórios atualizado.','success');});}
  async function approve(value:boolean){await run(async()=>{setSettings(await window.deskdata.setPaidQueriesApproved(value));show(value?'Consumo de créditos autorizado para esta conta.':'Consumo de créditos desabilitado para esta conta.','success');});}
  async function saveAgain(){await run(async()=>{const result=await window.deskdata.saveAgain();setLast(result);await refreshHistory();show(`PDF salvo novamente, sem nova consulta: ${reportFilename(result.path)}`,'success');});}
  async function reprocess(){await run(async()=>{
    const result=await window.deskdata.reprocessLast();
    setLast(result);setHasReport(true);setCanReprocess(false);await refreshHistory();
    show(`Resposta reprocessada sem nova consulta: ${reportFilename(result.path)}`,'success');
  });}
  function logout(){void run(async()=>{await window.deskdata.logout();setTab('acesso');setLogged(false);setCreditBalance(null);setLast(null);setHasReport(false);setCanReprocess(false);setHistoryEntries([]);setPisEntries([]);setCompanyEntries([]);setCpiStatus({state:'closed'});setCpiHistory(null);setCpiAuto(null);setSettings(current=>({...current,paidQueriesApproved:false}));show('Sessão encerrada.','success');});}
  function recover(event:FormEvent){event.preventDefault();void run(async()=>{
    const result=await window.deskdata.recoverByCode(cpfDigits(cpf),recoveryCode.trim().toUpperCase());
    showExecution(result,'CPF');
    await refreshHistory();setRecoveryCode('');
  });}
  async function regenerate(recordId:string){await run(async()=>{
    const result=await window.deskdata.regenerateHistory(recordId);
    showExecution(result,'CPF');
    await refreshHistory();
  });}
  function showPisOutcome(result:PisQueryExecution,viaGet=false):void{
    if(result.state==='no_pis'){
      show('A Deskdata não disponibilizou o número do PIS nesta consulta. Resultado registrado no histórico; nenhum PDF foi gerado. Não houve novo POST para recuperar este resultado.','info');
      return;
    }
    show(`${viaGet?'PDF do PIS recuperado por GET':result.pdf.reused?'Resultado existente reutilizado':'PDF do PIS gerado'}: ${reportFilename(result.pdf.path)}`,'success');
  }
  function queryPis(event:FormEvent){event.preventDefault();void run(async()=>{
    show('Consultando dados básicos para recuperar o PIS. Não repita a consulta.','info');
    try{
      const result=await window.deskdata.queryPisAndSave(cpfDigits(pisCpf));
      await refreshHistory();
      showPisOutcome(result);
    }finally{
      await refreshHistory();
      try{setCreditBalance(await window.deskdata.credits());}catch{setCreditBalance(null);}
    }
  });}
  async function regeneratePisPdf(recordId:string){await run(async()=>{
    const result=await window.deskdata.regeneratePis(recordId);
    await refreshHistory();
    showPisOutcome(result,true);
  });}
  function queryCompany(event:FormEvent){event.preventDefault();void run(async()=>{
    show('Consultando os dados empresariais. Não repita a operação enquanto estiver em andamento.','info');
    try{
      const result=await window.deskdata.queryCompanyAndSave(cnpjDigits(cnpj));
      showExecution(result,'CNPJ');
      await refreshHistory();
    }finally{
      await refreshHistory();
      try{setCreditBalance(await window.deskdata.credits());}catch{setCreditBalance(null);}
    }
  });}
  async function regenerateCompany(recordId:string){await run(async()=>{
    const result=await window.deskdata.regenerateCompany(recordId);
    showExecution(result,'CNPJ');
    await refreshHistory();
  });}
  async function openCpi(){await run(async()=>{
    setCpiStatus(await window.deskdata.cpiOpen());
    show('Janela CPI aberta. Autentique-se no portal e inicie o agente.','info');
  });}
  async function startFullCpi(){await run(async()=>{
    const interval=parseCpiMonitorIntervalInput(cpiIntervalInput);
    if(interval===null)throw new Error('Informe um intervalo válido entre 30 e 86400 segundos.');
    if(!settings.paidQueriesApproved)throw new Error('Autorize novas consultas em Minha conta antes de iniciar.');
    if(!window.confirm('INICIAR AGENTE CPI?\n\nO agente poderá realizar consultas pagas enquanto houver créditos Deskdata, classificar processos, gerar PDFs e salvar respostas na CPI. Não existe limite local de quantidade. Continuará uma pesquisa por vez; erros e estados incertos interrompem o processamento. Confirmar?'))return;
    setCpiAuto(await window.deskdata.cpiAutoStart(interval));
    show('Agente CPI iniciado. O saldo é verificado antes de cada nova consulta paga.','success');
  });}
  async function pauseFullCpi(){await run(async()=>{
    setCpiAuto(await window.deskdata.cpiAutoPause());
    show('Pausa solicitada. A operação em andamento será concluída antes de parar.','info');
    setCpiHistory(await window.deskdata.cpiHistory());
  });}
  async function closeCpi(){await run(async()=>{
    await window.deskdata.cpiClose();setCpiStatus({state:'closed'});
    show('Navegador CPI encerrado.','info');
  });}
  async function refreshCpiHistory(){await run(async()=>{
    setCpiHistory(await window.deskdata.cpiHistory());
    try{setCreditBalance(await window.deskdata.credits());}
    catch{setCreditBalance(null);}
  });}
  async function openCpiHistoryPdf(ids:CpiPendingRowId){await run(()=>window.deskdata.cpiOpenHistoryPdf(ids));}
  useEffect(()=>{
    if(!logged || tab!=='cpi')return;
    let active=true;
    const refresh=()=>{
      void window.deskdata.cpiHistory().then(v=>{if(active)setCpiHistory(v);}).catch(()=>{});
      void window.deskdata.credits().then(v=>{if(active)setCreditBalance(v);}).catch(()=>{if(active)setCreditBalance(null);});
    };
    void window.deskdata.cpiStatus().then(v=>{if(active)setCpiStatus(v);}).catch(()=>{});
    void window.deskdata.cpiAutoStatus().then(v=>{if(active)setCpiAuto(v);}).catch(()=>{});
    refresh();
    const unsubscribe=window.deskdata.subscribeCpiAuto(v=>{if(active)setCpiAuto(v);});
    const statusTimer=window.setInterval(()=>{
      void window.deskdata.cpiStatus().then(v=>{if(active)setCpiStatus(v);}).catch(()=>{});
    },5000);
    return ()=>{active=false;unsubscribe();window.clearInterval(statusTimer);};
  },[logged,tab]);
  useEffect(()=>{
    if(!logged || tab!=='cpi')return;
    void window.deskdata.cpiHistory().then(setCpiHistory).catch(()=>{});
    if(cpiAuto?.processed){void window.deskdata.credits().then(setCreditBalance).catch(()=>setCreditBalance(null));}
  },[logged,tab,cpiAuto?.processed]);
  useEffect(()=>{
    if(!logged||tab!=='cpi'||cpiAuto?.phase!=='waiting'||!cpiAuto.nextCheckAt)return;
    setCpiClockMs(Date.now());
    const timer=window.setInterval(()=>setCpiClockMs(Date.now()),1000);
    return ()=>window.clearInterval(timer);
  },[logged,tab,cpiAuto?.phase,cpiAuto?.nextCheckAt]);
  async function openHistory(recordId:string,path:string){
    await run(()=>window.deskdata.openHistoryPdf(recordId,path));
  }
  const cpiBrowserOpen=cpiStatus.state==='open';
  const cpiAutoRunning=cpiAuto?.phase==='running'||cpiAuto?.phase==='waiting';
  const cpiValidInterval=parseCpiMonitorIntervalInput(cpiIntervalInput);
  const cpiCountdown=cpiAuto?.phase==='waiting'
    ? getCpiRemainingSeconds(cpiAuto.nextCheckAt,cpiClockMs):null;
  if(!logged)return <div className="auth-page">
    <div className="auth-identity"><div className="brandmark">D</div><div><strong>DESKDATA</strong><small>RELATÓRIOS</small></div></div>
    <section className="auth-card" aria-labelledby="auth-title">
      <p className="eyebrow">ACESSO SEGURO</p><h1 id="auth-title">Entrar na Deskdata</h1>
      <p className="auth-description">Autentique-se para acessar as consultas de pessoas, PIS e CNPJ.</p>
      <form className="form" onSubmit={login}>
        <label>E-mail<input type="email" required autoComplete="username" placeholder="usuario@empresa.com.br" value={username} onChange={e=>{credentialsEdited.current=true;setUsername(e.target.value);}} disabled={busy}/></label>
        <label>Senha<input type="password" required autoComplete="current-password" value={password} onChange={e=>{credentialsEdited.current=true;setPassword(e.target.value);}} disabled={busy}/></label>
        <label className="remember-toggle"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} disabled={busy}/><span>Lembrar usuário e senha neste computador</span></label>
        {hasSavedCredentials?<div className="remember-actions"><span className="saved-credential-label"><Icon name="check" size={14}/> Dados salvos no dispositivo</span><button type="button" className="link-button" disabled={busy} onClick={()=>void fillSaved()}>Recarregar</button><button type="button" className="link-button" disabled={busy} onClick={()=>void forgetSaved()}>Esquecer</button></div>:null}
        <button className="primary large" disabled={busy||!username.trim()||!password} type="submit">{busy?'Autenticando...':'Autenticar'}</button>
      </form>
      <div className="login-privacy"><Icon name="shield" size={15}/> Dados protegidos no Windows. Autenticação sempre manual.</div>
    </section>
    <p className="auth-footnote">O sistema não inicia consultas sem sua autorização.</p>
    <ToastHost notice={notice} onDismiss={dismissNotice}/>
  </div>;
  return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brandmark">D</div><div><strong>DESKDATA</strong><small>RELATÓRIOS</small></div></div><p className="side-label">ÁREA DE TRABALHO</p><button type="button" className={`nav ${tab==='acesso'?'active':''}`} onClick={()=>setTab('acesso')}><Icon name="user" size={18}/> Minha conta</button><button type="button" className={`nav ${tab==='consultar'?'active':''}`} onClick={()=>setTab('consultar')}><Icon name="file" size={18}/> Consultar pessoa</button><button type="button" className={`nav ${tab==='pis'?'active':''}`} onClick={()=>setTab('pis')}><Icon name="id" size={18}/> Consultar PIS</button><button type="button" className={`nav ${tab==='company'?'active':''}`} onClick={()=>setTab('company')}><Icon name="building" size={18}/> Consultar CNPJ</button><button type="button" className={`nav ${tab==='cpi'?'active':''}`} onClick={()=>setTab('cpi')}><Icon name="refresh" size={18}/> Automação CPI</button><button type="button" className={`nav ${tab==='configurar'?'active':''}`} onClick={()=>setTab('configurar')}><Icon name="settings" size={18}/> Configurações</button><div className="sidebar-footer">Modelo 01 — Executivo<br/><span>Ambiente de desenvolvimento</span></div></aside>
  <div className="workspace"><header className="topbar"><span>DESKDATA / {tab==='consultar'?'Consulta de pessoas':tab==='pis'?'Consulta de PIS':tab==='company'?'Consulta de CNPJ':tab==='cpi'?'Automação CPI':tab==='acesso'?'Minha conta':'Configurações'}</span><span className={`session ${logged?'online':''}`}><span className="dot"/>{logged?'Conectado':'Não autenticado'}</span></header><main className="main">
  {tab==='consultar'?<><div className="page-heading"><div><p className="eyebrow">CONSULTAS AUTOMATIZADAS</p><h1>Consultar pessoa</h1><p>Informe o CPF. Os dados serão consultados e transformados em PDF automaticamente.</p></div><span className="pill">Modelo 01 · A4</span></div>
  <div className="single-column">
  <section className="panel"><div className="panel-heading"><h2>Consulta e PDF</h2><p>Um CPF por consulta, cinco conjuntos fixos.</p></div><form className="form" onSubmit={query}><label>CPF da pessoa consultada<input inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" maxLength={14} value={cpf} onChange={e=>setCpf(formatCpf(cpfDigits(e.target.value).slice(0,11)))} disabled={busy}/></label><div className="chips">{DATASET_LABELS.map(label=><span key={label} className="chip">{label}</span>)}</div><button className="primary large" type="submit" disabled={busy||!logged||!isValidCpf(cpf)||!settings.outputFolder}>{busy?'Processando...':'Consultar e gerar PDF'}</button>{!settings.outputFolder||!settings.paidQueriesApproved?<p className="hint">Defina a pasta em Configurações. Autorize novas consultas em Minha conta.</p>:null}</form><details className="code-recovery"><summary>Recuperar consulta pelo código Q-...</summary><form onSubmit={recover} className="recovery-form"><label htmlFor="query-code">Código de uma consulta existente</label><input id="query-code" placeholder="Q-ABC123DEF4" value={recoveryCode} maxLength={12} onChange={e=>setRecoveryCode(e.target.value.toUpperCase())} disabled={busy}/><button className="secondary" disabled={!logged||busy||!isValidCpf(cpf)||!/^Q-[A-F0-9]{10}$/.test(recoveryCode)} type="submit">Recuperar resultado (GET)</button></form><p className="hint">Utiliza o CPF informado acima e um código conhecido. Não cria nova consulta.</p></details></section></div>
  <section className="panel result-panel"><div className="panel-heading"><h2>Resultado e histórico</h2><p>Todos os PDFs registrados nesta instalação. Cada arquivo pode ser aberto individualmente.</p></div>
  <div className="history-list" aria-label="Histórico de relatórios">
  {historyEntries.length?historyEntries.map(record=><article className="history-entry" key={record.id}>
    <div className="history-top"><div><strong>CPF {formatCpf(record.cpf)}</strong><span className="history-date">{new Date(record.requestedAt).toLocaleString('pt-BR')}</span></div><span className={`history-status ${record.status}`}>{statusText(record)}</span></div>
    {record.queryCode?<div className="query-reuse"><small className="query-code">Código: {record.queryCode}</small>{historyAction(record)}</div>:null}
    {record.pdfPaths.length?record.pdfPaths.map(file=><div className="pdf-item" key={file}><div className="doc-icon">PDF</div><div className="result-detail"><strong>{reportFilename(file)}</strong><span title={file}>{file}</span></div><button type="button" className="primary" disabled={busy} onClick={()=>void openHistory(record.id,file)}>Abrir PDF</button></div>):<p className="hint">{record.status==='pending'?'O resultado será gerado automaticamente quando a Deskdata concluir.':record.status==='paused'?(record.lastIssue??'Recuperação pausada; clique em Retomar GET.') :record.queryCode?'Consulta recuperável pelo código, sem criar novo POST.':'Nenhum código disponível. Não repita a consulta antes de verificar a operação anterior.'}</p>}
  </article>):<div className="empty-result"><span>▧</span><p>{logged?'Nenhuma consulta registrada nesta versão.':'Autentique-se para visualizar o histórico protegido.'}</p></div>}
  </div>
  <div className="actions"><button className="secondary" disabled={busy||!settings.outputFolder} onClick={()=>void run(()=>window.deskdata.openFolder())}>Abrir pasta</button><button className="secondary" disabled={busy||!hasReport} onClick={()=>void saveAgain()}>Salvar novamente sem consultar</button>{canReprocess?<button className="secondary" disabled={busy} onClick={()=>void reprocess()}>Reprocessar resposta recebida</button>:null}</div></section>
  </>:tab==='pis'?<>
  <div className="page-heading"><div><p className="eyebrow">CONSULTA INDIVIDUAL</p><h1>Consultar PIS</h1><p>Informe o CPF para gerar um PDF compacto com os dados cadastrais e o PIS retornado.</p></div><span className="pill">Dados básicos · A4</span></div>
  <section className="panel pis-form-panel">
    <div className="panel-heading"><h2>Consulta por CPF</h2><p>Utiliza somente o conjunto Dados básicos. A autenticação é compartilhada com Consultar pessoa.</p></div>
    <form className="form" onSubmit={queryPis}>
      <label>CPF da pessoa consultada<input inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" maxLength={14} value={pisCpf} onChange={e=>setPisCpf(formatCpf(cpfDigits(e.target.value).slice(0,11)))} disabled={busy}/></label>
      <div className="chips"><span className="chip">Dados básicos (basic)</span></div>
      <button className="primary large" type="submit" disabled={busy||!logged||!isValidCpf(pisCpf)||!settings.outputFolder}>{busy?'Processando...':'Consultar PIS e gerar PDF'}</button>
      {(!settings.outputFolder||!settings.paidQueriesApproved)?<p className="hint">Configure a pasta de destino e autorize créditos em Minha conta para novas consultas. Resultados recuperáveis serão reutilizados sempre que possível.</p>:null}
    </form>
  </section>
  <section className="panel result-panel"><div className="panel-heading"><h2>Resultados de PIS</h2><p>Histórico separado dos relatórios de pessoas. Cada PDF tem seu próprio botão para abrir.</p></div>
    <div className="history-list" aria-label="Histórico de consultas PIS">
    {pisEntries.length?pisEntries.map(record=><article className="history-entry" key={record.id}>
      <div className="history-top"><div><strong>CPF {formatCpf(record.cpf)}</strong><span className="history-date">{new Date(record.requestedAt).toLocaleString('pt-BR')}</span></div><span className={`history-status ${record.status}`}>{record.status==='pis_unavailable'?'PIS não informado':record.pdfPaths.length?'PDF disponível':record.queryCode?'Recuperável por código':'Pendente de verificação'}</span></div>
      {record.queryCode?<div className="query-reuse"><small className="query-code">Código: {record.queryCode}</small><button type="button" className="secondary" disabled={busy} onClick={()=>void regeneratePisPdf(record.id)}>{record.status==='pis_unavailable'?'Verificar novamente via GET':'Regerar PDF via GET'}</button></div>:null}
      {record.pdfPaths.length?record.pdfPaths.map(file=><div className="pdf-item" key={file}><div className="doc-icon">PDF</div><div className="result-detail"><strong>{reportFilename(file)}</strong><span title={file}>{file}</span></div><button type="button" className="primary" disabled={busy} onClick={()=>void openHistory(record.id,file)}>Abrir PDF</button></div>):<p className="hint">{record.status==='pis_unavailable'?'Número do PIS não disponibilizado pela Deskdata nesta consulta. Nenhum PDF foi gerado.':record.queryCode?'Informe o CPF acima e consulte para recuperar o resultado sem novo POST.':'Sem PDF ou código. Verifique a consulta antes de realizar outra operação.'}</p>}
    </article>):<div className="empty-result"><span>▧</span><p>{logged?'Nenhum relatório de PIS nesta instalação.':'Autentique-se para consultar o histórico protegido.'}</p></div>}
    </div>
    <div className="actions"><button className="secondary" disabled={busy||!settings.outputFolder} onClick={()=>void run(()=>window.deskdata.openFolder())}>Abrir pasta</button></div>
  </section>
  </>:tab==='company'?<>
  <div className="page-heading"><div><p className="eyebrow">CONSULTAS EMPRESARIAIS</p><h1>Consultar CNPJ</h1><p>Consulta automática de informações empresariais e geração de PDF no padrão executivo.</p></div><span className="pill">Relatório empresarial · A4</span></div>
  <section className="panel pis-form-panel"><div className="panel-heading"><h2>Consulta por CNPJ</h2><p>Utiliza a autenticação e a pasta de relatórios existentes.</p></div>
    <form className="form" onSubmit={queryCompany}>
      <label>CNPJ da empresa<input inputMode="numeric" autoComplete="off" placeholder="00.000.000/0000-00" maxLength={18} value={cnpj} onChange={e=>setCnpj(formatCnpj(cnpjDigits(e.target.value).slice(0,14)))} disabled={busy}/></label>
      <div className="chips">{['Dados básicos','Telefones','Endereços','E-mails','Relacionamentos','Processos judiciais'].map(v=><span key={v} className="chip">{v}</span>)}</div>
      <p className="hint">Telefones de relacionamentos: dataset temporariamente indisponível na Deskdata, não solicitado.</p>
      <button className="primary large" type="submit" disabled={busy||!logged||!isValidCnpj(cnpj)||!settings.outputFolder}>{busy?'Processando...':'Consultar CNPJ e gerar PDF'}</button>
      {!settings.paidQueriesApproved?<p className="hint">Consultas inéditas exigem autorização de créditos em Minha conta. Resultados já registrados serão reutilizados sem novo POST.</p>:null}
    </form>
  </section>
  <section className="panel result-panel"><div className="panel-heading"><h2>Resultados de CNPJ</h2><p>Histórico independente, com rolagem e abertura individual de cada PDF.</p></div>
    <div className="history-list" aria-label="Histórico de consultas empresariais">
      {companyEntries.length?companyEntries.map(record=><article className="history-entry" key={record.id}>
        <div className="history-top"><div><strong>CNPJ {formatCnpj(record.cnpj??'')}</strong><span className="history-date">{new Date(record.requestedAt).toLocaleString('pt-BR')}</span></div><span className={`history-status ${record.status}`}>{statusText(record)}</span></div>
        {record.queryCode?<div className="query-reuse"><small className="query-code">Código: {record.queryCode}</small>{historyAction(record)}</div>:null}
        {record.pdfPaths.length?record.pdfPaths.map(file=><div className="pdf-item" key={file}><div className="doc-icon">PDF</div><div className="result-detail"><strong>{reportFilename(file)}</strong><span title={file}>{file}</span></div><button type="button" className="primary" disabled={busy} onClick={()=>void openHistory(record.id,file)}>Abrir PDF</button></div>):<p className="hint">{record.status==='pending'?'Aguardando conclusão; o PDF será gerado automaticamente.':record.status==='paused'?(record.lastIssue??'Recuperação pausada; clique em Retomar GET.') :record.queryCode?'Recuperável por código via GET.':'Nenhum código disponível. Não envie nova consulta antes de verificar o resultado anterior.'}</p>}
      </article>):<div className="empty-result"><span>▧</span><p>{logged?'Nenhuma consulta empresarial registrada.':'Autentique-se para visualizar o histórico protegido.'}</p></div>}
    </div>
    <div className="actions"><button className="secondary" disabled={busy||!settings.outputFolder} onClick={()=>void run(()=>window.deskdata.openFolder())}>Abrir pasta</button></div>
  </section>
  </>:tab==='cpi'?<>
    <div className="page-heading cpi-dashboard-heading"><div><p className="eyebrow">OPERAÇÃO AUTOMÁTICA · PESQUISA 29</p><h1>Agente CPI Central</h1><p>Monitore as consultas, os relatórios e as respostas enviadas à CPI em um único lugar.</p></div><span className="pill">Consultar pessoa · FULL AUTO</span></div>
    <div className="cpi-dashboard-grid" role="group" aria-label="Indicadores do agente">
      <div className="cpi-kpi"><span>Estado do agente</span><strong className={`cpi-state ${cpiAuto?.phase??'stopped'}`}>{({running:'Processando',waiting:'Em espera',paused:'Pausado',error:'Falha',stopped:'Parado'})[cpiAuto?.phase??'stopped']}</strong><small>{cpiAuto?.phase==='waiting'?'Monitoramento ativo':cpiAuto?.phase==='error'?'Intervenção necessária':'Pesquisa 29'}</small></div>
      <div className="cpi-kpi"><span>Respondidas no histórico</span><strong>{cpiHistory?.completedCount??'—'}</strong><small>Registros confirmados nesta conta</small></div>
      <div className="cpi-kpi"><span>Necessitam revisão</span><strong>{cpiHistory?.reviewCount??'—'}</strong><small>Sem reenvio automático</small></div>
      <div className="cpi-kpi"><span>Créditos Deskdata</span><strong>{creditBalance===null?'Indisponível':creditBalance.toLocaleString('pt-BR')}</strong><small>Saldo consultado na API</small></div>
    </div>
    <section className="panel cpi-dashboard-panel" aria-labelledby="cpi-operation-title">
      <div className="panel-heading"><h2 id="cpi-operation-title">Operação do agente</h2><p>Uma solicitação por vez, reaproveitando o histórico. Novas consultas pagas continuam enquanto houver saldo disponível e autorização da conta.</p></div>
      <div className="cpi-agent-toolbar">
        <span className={`cpi-browser-indicator${cpiBrowserOpen?' online':''}`}><span className="dot"/>{cpiBrowserOpen?'CPI conectada':'CPI desconectada'}</span>
        <label className="cpi-interval" htmlFor="cpi-agent-interval">Verificar a cada (segundos)<input id="cpi-agent-interval" type="number" min={CPI_MIN_INTERVAL_SECONDS} max={CPI_MAX_INTERVAL_SECONDS} step={1} inputMode="numeric" value={cpiIntervalInput} onChange={event=>setCpiIntervalInput(event.target.value)} disabled={busy||cpiAutoRunning} aria-invalid={cpiValidInterval===null}/></label>
        <div className="cpi-agent-actions">
          <button type="button" className="secondary" onClick={()=>void openCpi()} disabled={busy||cpiBrowserOpen}>Abrir CPI no Edge</button>
          <button type="button" className="primary" disabled={busy||!cpiBrowserOpen||cpiAutoRunning||cpiValidInterval===null||!settings.paidQueriesApproved} onClick={()=>void startFullCpi()}>Iniciar agente</button>
          <button type="button" className="secondary" disabled={busy||!cpiAutoRunning} onClick={()=>void pauseFullCpi()}>Pausar</button>
          <button type="button" className="secondary" disabled={busy||!cpiBrowserOpen||cpiAutoRunning} onClick={()=>void closeCpi()}>Fechar Edge</button>
        </div>
      </div>
      {!settings.paidQueriesApproved?<p className="hint" role="status">Autorize o consumo de créditos em <strong>Minha conta</strong> para iniciar o agente. A confirmação de início continua obrigatória.</p>:null}
      {cpiAuto?.phase==='waiting'&&cpiCountdown!==null?<p className="cpi-countdown" role="timer" aria-live="off">Próxima verificação em <strong>{formatCpiCountdown(cpiCountdown)}</strong></p>:null}
      {cpiAuto?.lastMessage?<div className={`cpi-agent-message${cpiAuto.phase==='error'?' error':''}`} role="status">{cpiAuto.lastMessage}</div>:null}
      <p className="hint">Ciclos nesta sessão: {cpiAuto?.checks??0} · Concluídas nesta sessão: {cpiAuto?.processed??0}. Sem teto local de consultas; saldo zerado ou insuficiente, erro de identificação e salvamento incerto suspendem novos envios. Não há repetição automática de POST ou anexo.</p>
    </section>
    <section className="panel cpi-dashboard-panel" aria-labelledby="cpi-history-title">
      <div className="cpi-history-heading"><div className="panel-heading"><h2 id="cpi-history-title">Histórico de respostas na CPI</h2><p>Somente pesquisas concluídas pelo agente e vinculadas à conta autenticada. Os dados permanecem protegidos no computador.</p></div><button type="button" className="secondary" disabled={busy} onClick={()=>void refreshCpiHistory()}>Atualizar histórico</button></div>
      <div className="cpi-history-table" role="region" aria-label="Solicitações respondidas na CPI" tabIndex={0}>
        <table><thead><tr><th>Pesquisa</th><th>Solicitação</th><th>Resultado</th><th>Respondida em</th><th>Relatório</th></tr></thead><tbody>
        {cpiHistory?.items.map(item=><tr key={`${item.pesquisaId}-${item.solicitacaoId}`}><td className="cpi-id">{item.pesquisaId}</td><td className="cpi-id">{item.solicitacaoId}</td><td><span className={`cpi-classification ${item.classification}`}>{item.classification==='restrictions'?'Sim, Consta Restrições':'Há Informações'}</span></td><td>{new Date(item.answeredAt).toLocaleString('pt-BR')}</td><td><button type="button" className="secondary" disabled={busy||!item.pdfAvailable} onClick={()=>void openCpiHistoryPdf(item)}>{item.pdfAvailable?'Abrir PDF':'Indisponível'}</button></td></tr>)}
        {!cpiHistory?.items.length?<tr><td colSpan={5} className="cpi-empty-history">Nenhuma pesquisa concluída pelo agente nesta conta.</td></tr>:null}
        </tbody></table>
      </div>
      {cpiHistory&&cpiHistory.completedCount>cpiHistory.items.length?<p className="hint">Exibindo as {cpiHistory.items.length} respostas mais recentes de {cpiHistory.completedCount} registros.</p>:null}
      {cpiHistory?.reviewCount?<p className="hint cpi-review-notice">Existem {cpiHistory.reviewCount} solicitações que exigem conferência antes de qualquer reprocessamento. O agente não realizará envios duplicados.</p>:null}
    </section>
  </>:tab==='configurar'?<><div className="page-heading"><div><p className="eyebrow">PREFERÊNCIAS LOCAIS</p><h1>Configurações</h1><p>Defina estas opções uma vez. Não será necessário selecioná-las em cada consulta.</p></div></div><section className="panel settings-panel"><div className="panel-heading"><h2>Pasta de saída dos PDFs</h2><p>Os relatórios serão salvos automaticamente na pasta selecionada.</p></div><div className="folder"><span>{settings.outputFolder??'Nenhuma pasta selecionada'}</span><button type="button" className="secondary" disabled={busy} onClick={()=>void folder()}>Selecionar pasta</button></div><div className="divider"/><div className="panel-heading"><h2>Backup do histórico</h2><p>Crie uma cópia ZIP dos registros cifrados, da chave protegida e das configurações essenciais. Não inclui senhas nem PDFs.</p></div>
    <div className="backup-actions"><button type="button" className="primary" disabled={busy} onClick={()=>void createBackup()}><Icon name="file" size={17}/> Criar backup ZIP</button><button type="button" className="secondary" disabled={busy} onClick={()=>void openBackupFolder()}><Icon name="folder" size={17}/> Abrir pasta de backups</button></div>
    {backupInfo?<p className="hint backup-path" title={backupInfo}>Último backup: {backupInfo}</p>:null}
    <div className="backup-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>void openDiagnosticsFolder()}><Icon name="folder" size={17}/> Abrir logs de diagnóstico</button></div>
    <p className="hint">O ZIP é vinculado à proteção desta conta do Windows. A recuperação em outro computador não é garantida. Não exclua os dados originais antes de conferir seu backup.</p>
    <div className="divider"/><div className="panel-heading"><h2>Limpeza de arquivos e registros locais</h2><p>Remova arquivos e histórico desta instalação. A área abaixo tem rolagem independente.</p></div>
  <div className="cleanup-scroll" role="region" aria-label="Opções para limpar dados locais" tabIndex={0}>
    <div className="cleanup-counts"><span>PDFs registrados: <strong>{cleanupPreview?.pdfCount??'—'}</strong></span><span>Consultas registradas: <strong>{cleanupPreview?.recordCount??'—'}</strong></span><span>Pendentes/incertas: <strong>{cleanupPreview?.pendingCount??'—'}</strong></span></div>
    <label className="cleanup-option"><input type="checkbox" checked={removePdfs} disabled={busy} onChange={e=>setRemovePdfs(e.target.checked)}/><span><strong>Excluir PDFs gerados</strong><small>Somente PDFs reconhecidos e cadastrados no histórico DESKDATA, inclusive os de pastas utilizadas anteriormente. Não remove outros documentos da pasta.</small></span></label>
    <label className="cleanup-option"><input type="checkbox" checked={removeHistory} disabled={busy} onChange={e=>setRemoveHistory(e.target.checked)}/><span><strong>Excluir histórico de todas as consultas</strong><small>Apaga registros locais, estados e códigos de recuperação de todas as contas desta instalação. Sem esses códigos, consultas antigas podem exigir nova cobrança. Se esta opção estiver isolada, os PDFs permanecem em disco.</small></span></label>
    <p className="hint">Os logs técnicos são registrados sem CPFs, senhas, tokens ou respostas de consultas. As informações da conta na Deskdata não serão excluídas. Credenciais lembradas e configurações serão preservadas.</p>
  </div>
  <div className="cleanup-actions"><button type="button" className="danger-button" disabled={busy||(!removePdfs&&!removeHistory)||!cleanupPreview} onClick={()=>void cleanupLocal()}>Excluir dados selecionados</button><span className="hint">O Windows solicitará uma confirmação antes da exclusão definitiva.</span></div></section></>:<><div className="page-heading"><div><p className="eyebrow">ÁREA AUTENTICADA</p><h1>Minha conta</h1><p>Sessão ativa, saldo disponível e autorização para novas consultas.</p></div></div>
  <section className="panel settings-panel"><div className="panel-heading"><h2>Acesso à Deskdata</h2><p>Conta autenticada neste aplicativo.</p></div>
    <div className="logged-info"><div className="ok-icon">✓</div><div className="logged-copy"><strong>Autenticação concluída</strong><span>{username||'Sessão autenticada'} · Créditos: {creditBalance===null?'Indisponível':creditBalance.toLocaleString('pt-BR')}</span></div><button className="secondary" type="button" onClick={logout} disabled={busy}>Sair da conta</button></div>
    <div className="divider"/><h2>Autorização de créditos</h2><label className="approve"><input type="checkbox" checked={settings.paidQueriesApproved} disabled={busy} onChange={e=>void approve(e.target.checked)}/><span>Autorizo consultas reais à Deskdata, ciente de que os datasets podem consumir créditos da minha conta.</span></label><p className="hint">A recuperação de resultados por GET não gera um novo POST. A autorização pode ser revogada a qualquer momento.</p>
    <div className="divider"/><h2>Conjuntos utilizados</h2><p className="hint">Consultar pessoa utiliza cinco conjuntos. Consultar PIS utiliza Dados básicos. Consultar CNPJ utiliza seis conjuntos disponíveis.</p><div className="chips">{DATASET_LABELS.map(label=><span className="chip" key={label}>{label}</span>)}</div>
  </section></>}
  </main></div><ToastHost notice={notice} onDismiss={dismissNotice}/></div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
