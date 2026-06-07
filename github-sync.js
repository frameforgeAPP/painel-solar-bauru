const admin = require("firebase-admin");

// 1. Inicialização do Firebase Admin com a chave de serviço do GitHub Secrets
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Erro: A variável de ambiente FIREBASE_SERVICE_ACCOUNT não foi configurada.");
    process.exit(1);
}

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (err) {
    console.error("Erro ao inicializar o Firebase Admin:", err.message);
    process.exit(1);
}

const db = admin.firestore();

// Configurações SolaX — lidas dos GitHub Secrets (nunca hardcoded no código)
const SOLAX_TOKEN = process.env.SOLAX_TOKEN;
const SOLAX_SN1 = process.env.SOLAX_SN1;
const SOLAX_SN2 = process.env.SOLAX_SN2;

if (!SOLAX_TOKEN || !SOLAX_SN1 || !SOLAX_SN2) {
    console.error("Erro: Variáveis de ambiente SOLAX_TOKEN, SOLAX_SN1 ou SOLAX_SN2 não configuradas.");
    process.exit(1);
}

const DEVICES = [
    { sn: SOLAX_SN1, name: 'Micro Inv. 1 (Micro-4in1)' },
    { sn: SOLAX_SN2, name: 'Micro Inv. 2 (Micro-4in1)' }
];

/**
 * Realiza a chamada à API do SolaX com tentativas (retry) em caso de falha.
 */
async function fetchInverterWithRetry(sn, tokenId, retries = 3, delayMs = 2000) {
    const url = `https://global.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${tokenId}&sn=${sn}&t=${Date.now()}`;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`[Solax SN: ${sn}] Tentativa ${attempt} de busca de dados...`);
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data && data.success) {
                return data.result;
            } else {
                throw new Error(data.exception || "API respondeu com success=false");
            }
        } catch (err) {
            console.warn(`[Solax SN: ${sn}] Tentativa ${attempt} falhou: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

async function runSync() {
    console.log("Iniciando execução do script de sincronização no GitHub Actions...");

    // Valida se está dentro do horário operacional das 06:30 às 19:30 no fuso de São Paulo
    const timeStr = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const [hourStr, minStr] = timeStr.split(':');
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minStr, 10);
    const timeValue = hour * 100 + minute;

    const isManualRun = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
    if ((timeValue < 630 || timeValue > 1930) && !isManualRun) {
        console.log(`Fora do horário operacional solicitado (${timeStr}). Encerrando execução antecipadamente.`);
        return;
    }

    const todayStr = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    console.log(`Data calculada no fuso de São Paulo: ${todayStr}`);

    // 1. Consultar ambos os inversores em paralelo
    const results = await Promise.allSettled(
        DEVICES.map(dev => fetchInverterWithRetry(dev.sn, SOLAX_TOKEN))
    );

    let totalYield = 0;
    let totalWatts = 0;
    let totalLifetime = 0;
    let successCount = 0;
    const inverterDetails = [];

    results.forEach((r, index) => {
        const devName = DEVICES[index].name;
        const devSn = DEVICES[index].sn;
        if (r.status === 'fulfilled' && r.value) {
            const watts = Number(r.value.acpower || r.value.acPower || 0);
            const yDay = Number(r.value.yieldtoday || r.value.yieldToday || 0);
            const yLifetime = Number(r.value.yieldtotal || r.value.yieldTotal || 0);
            const temp = Number(r.value.inverterTemp || 0);
            
            totalYield += yDay;
            totalWatts += watts;
            totalLifetime += yLifetime;
            successCount++;
            inverterDetails[index] = {
                sn: devSn,
                name: devName,
                watts,
                production: yDay,
                lifetimeKwh: yLifetime,
                temp
            };
            
            console.log(`[Solax] Inversor ${index + 1} (${devName}): ${watts}W | Hoje: ${yDay}kWh | Total: ${yLifetime}kWh | Temp: ${temp}°C`);
        } else {
            const errorMsg = r.status === 'rejected' ? r.reason.message : 'Sem dados válidos';
            console.error(`[Solax] Falha ao obter dados do Inversor ${index + 1} (${devSn}): ${errorMsg}`);
        }
    });

    // 2. Só prossegue se ambos os inversores responderam com sucesso
    if (successCount !== DEVICES.length) {
        console.warn(`[Solax] Apenas ${successCount} de ${DEVICES.length} inversores responderam. Cancelando gravação para evitar dados parciais.`);
        process.exit(1); // Falha intencional para disparar o alerta por e-mail do GitHub Actions
    }

    try {
        // 3. ID do documento = data no formato ISO (ex: "2026-05-31") — 1 documento por dia
        const leiturasCol = db.collection("leituras");
        const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // "YYYY-MM-DD"

        // 3a. Verifica se já existe documento para hoje (pode ter import/export sincronizado manualmente)
        const todayDocRef = leiturasCol.doc(todayISO);
        const todayDocSnap = await todayDocRef.get();

        let lastImport = 0;
        let lastExport = 0;
        let lastProduction = 0;
        let lastDate = "";
        let todayAlreadyExists = todayDocSnap.exists;

        if (todayAlreadyExists) {
            // Já existe registro de hoje: herda import/export do próprio documento do dia
            // (pode ter sido sincronizado manualmente pelo usuário — não deve ser sobrescrito)
            const d = todayDocSnap.data();
            lastImport = Number(d.import) || 0;
            lastExport = Number(d.export) || 0;
            lastProduction = Number(d.production) || 0;
            lastDate = d.date || todayStr;
            console.log(`[Hoje já existe] Herdando import/export do doc de hoje: import: ${lastImport} | export: ${lastExport} | prod: ${lastProduction}`);
        } else {
            // Primeira escrita do dia: herda import/export do último documento gravado (qualquer dia)
            const snapshot = await leiturasCol.orderBy("timestamp", "desc").limit(1).get();
            if (!snapshot.empty) {
                const lastDoc = snapshot.docs[0].data();
                lastImport = Number(lastDoc.import) || 0;
                lastExport = Number(lastDoc.export) || 0;
                lastProduction = Number(lastDoc.production) || 0;
                lastDate = lastDoc.date || "";
                console.log(`[Primeiro registro do dia] Herdando de (${lastDate}): import: ${lastImport} | export: ${lastExport} | prod: ${lastProduction}`);
            } else {
                console.warn("A coleção 'leituras' está vazia.");
            }
        }

        // 4. Lógica de Proteção contra Lag SolaX
        let prodToSave = totalYield;
        if (lastDate !== "" && lastDate !== todayStr) {
            if (prodToSave === lastProduction && totalWatts === 0) {
                console.log(`[Lag Protect] Detectada leitura de ontem acumulada. Zerando geração do início do dia.`);
                prodToSave = 0;
            }
        }

        // 5. Calcular geração total acumulada (yieldtotal dos dois inversores - offset de fábrica de 6.40 kWh)
        // Offset: energia gerada em fábrica/testes antes da instalação, que consta na memória do inversor mas não no SolaxCloud.
        const LIFETIME_OFFSET = 6.40;
        const lifetimeKwh = totalLifetime > 0 ? Number(Math.max(0, totalLifetime - LIFETIME_OFFSET).toFixed(2)) : 0;
        if (lifetimeKwh > 0) {
            console.log(`[Solax] Geração Total Acumulada: ${totalLifetime} kWh (bruto) - ${LIFETIME_OFFSET} kWh (offset) = ${lifetimeKwh} kWh`);
        }

        const newPowerPoint = {
            time: timeStr.slice(0, 5), // formato HH:MM
            watts: totalWatts,
            inverterWatts: inverterDetails.map(inv => Number(inv.watts) || 0),
            inverterTemps: inverterDetails.map(inv => Number(inv.temp) || 0),
            timestamp: Date.now()
        };

        if (todayAlreadyExists) {
            // 6a. Documento do dia já existe → atualiza APENAS os campos solares
            //     import/export NÃO são tocados (preserva sync manual do usuário)
            await todayDocRef.update({
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                production: Number(prodToSave.toFixed(2)),
                lifetimeKwh: lifetimeKwh,
                watts: totalWatts,
                inverterWatts: inverterDetails.map(inv => Number(inv.watts) || 0),
                inverterTemps: inverterDetails.map(inv => Number(inv.temp) || 0),
                inverters: inverterDetails,
                powerCurve: admin.firestore.FieldValue.arrayUnion(newPowerPoint)
            });
            console.log(`[Atualizado] Doc ${todayISO} | watts: ${totalWatts}W | prod: ${prodToSave}kWh | lifetimeKwh: ${lifetimeKwh}kWh`);
        } else {
            // 6b. Primeiro registro do dia → cria o documento completo herdando import/export de ontem
            await todayDocRef.set({
                date: todayStr,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                import: lastImport,
                export: lastExport,
                production: Number(prodToSave.toFixed(2)),
                lifetimeKwh: lifetimeKwh,
                watts: totalWatts,
                inverterWatts: inverterDetails.map(inv => Number(inv.watts) || 0),
                inverterTemps: inverterDetails.map(inv => Number(inv.temp) || 0),
                inverters: inverterDetails,
                powerCurve: [newPowerPoint]
            });
            console.log(`[Criado] Doc ${todayISO} | watts: ${totalWatts}W | prod: ${prodToSave}kWh | import herdado: ${lastImport} | export herdado: ${lastExport}`);
        }

    } catch (err) {
        console.error(`Erro ao interagir com o Firestore: ${err.message}`, err);
    }
}

runSync();
