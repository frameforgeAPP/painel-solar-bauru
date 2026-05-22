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

// Configurações SolaX
const SOLAX_TOKEN = '202605120608478230237210';
const DEVICES = [
    { sn: 'C02711021F3193', name: 'Micro Inv. 1 (Micro-4in1)' },
    { sn: 'C02711021F312R', name: 'Micro Inv. 2 (Micro-4in1)' }
];

/**
 * Realiza a chamada à API do SolaX com tentativas (retry) em caso de falha.
 */
async function fetchInverterWithRetry(sn, tokenId, retries = 3, delayMs = 2000) {
    const url = `https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${tokenId}&sn=${sn}&t=${Date.now()}`;
    
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

    if (timeValue < 630 || timeValue > 1930) {
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
    let successCount = 0;
    const inverterDetails = [];

    results.forEach((r, index) => {
        const devName = DEVICES[index].name;
        const devSn = DEVICES[index].sn;
        if (r.status === 'fulfilled' && r.value) {
            const watts = Number(r.value.acpower || r.value.acPower || 0);
            const yDay = Number(r.value.yieldtoday || r.value.yieldToday || 0);
            
            totalYield += yDay;
            totalWatts += watts;
            successCount++;
            inverterDetails[index] = {
                sn: devSn,
                name: devName,
                watts,
                production: yDay
            };
            
            console.log(`[Solax] Inversor ${index + 1} (${devName}): ${watts}W | Hoje: ${yDay}kWh`);
        } else {
            const errorMsg = r.status === 'rejected' ? r.reason.message : 'Sem dados válidos';
            console.error(`[Solax] Falha ao obter dados do Inversor ${index + 1} (${devSn}): ${errorMsg}`);
        }
    });

    // 2. Só prossegue se ambos os inversores responderam com sucesso
    if (successCount !== DEVICES.length) {
        console.warn(`[Solax] Apenas ${successCount} de ${DEVICES.length} inversores responderam. Cancelando gravação para evitar dados parciais.`);
        return;
    }

    try {
        // 3. Buscar o último documento da coleção "leituras" para herdar dados CPFL
        const leiturasCol = db.collection("leituras");
        const snapshot = await leiturasCol.orderBy("timestamp", "desc").limit(1).get();

        let lastImport = 0;
        let lastExport = 0;
        let lastProduction = 0;
        let lastDate = "";

        if (!snapshot.empty) {
            const lastDoc = snapshot.docs[0].data();
            lastImport = Number(lastDoc.import) || 0;
            lastExport = Number(lastDoc.export) || 0;
            lastProduction = Number(lastDoc.production) || 0;
            lastDate = lastDoc.date || "";
            
            console.log(`Dados herdados da última leitura (${lastDate}): import: ${lastImport} | export: ${lastExport} | prod: ${lastProduction}`);
        } else {
            console.warn("A coleção 'leituras' está vazia.");
        }

        // 4. Lógica de Proteção contra Lag SolaX
        let prodToSave = totalYield;
        if (lastDate !== "" && lastDate !== todayStr) {
            if (prodToSave === lastProduction && totalWatts === 0) {
                console.log(`[Lag Protect] Detectada leitura de ontem acumulada. Zerando geração do início do dia.`);
                prodToSave = 0;
            }
        }

        // 5. Gravar o novo documento
        const reading = {
            date: todayStr,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            import: lastImport,
            export: lastExport,
            production: Number(prodToSave.toFixed(2)),
            watts: totalWatts,
            inverterWatts: inverterDetails.map(inv => Number(inv.watts) || 0),
            inverters: inverterDetails
        };

        const docRef = await leiturasCol.add(reading);
        console.log(`[Sucesso] Leitura gravada com sucesso! ID: ${docRef.id} | watts: ${totalWatts}W | prod: ${prodToSave}kWh`);

    } catch (err) {
        console.error(`Erro ao interagir com o Firestore: ${err.message}`, err);
    }
}

runSync();
