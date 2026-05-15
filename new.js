// Alterações no arquivo C:/Users/Raiden/Documents/Projetos/30. Novo Medidor/script.js

// 1. Localize a função renderChart e remova o limite de 14 dias:
function renderChart() {
    const canvas = document.getElementById('energyChart');
    if (!canvas) return;

    let dailyData = [];
    const today = new Date();
    const todayStr = formatDate(today);

    const dailyGridMap = {};
    state.gridReadings.forEach(r => {
        const d = getReadingDate(r);
        if (!dailyGridMap[d] || getReadingTimeValue(r) > getReadingTimeValue(dailyGridMap[d])) dailyGridMap[d] = r;
    });

    // Removido o limite de 14 dias para respeitar sempre a data de início da operação
    let startDate = new Date(SOLAR_OPERATION_START);

    for (let d = new Date(startDate); d <= today; d = addDays(d, 1)) {
        const dateKey = formatDate(d);
        
        // Prioriza o dado da API para a barra amarela (Geração)
        let solarProd = state.solarReadings[dateKey] !== undefined ? Number(state.solarReadings[dateKey]) : 0;
        if (dateKey === todayStr) {
            // Garante que o valor da API (state.productionToday) seja usado se for maior ou se o sync solar estiver ativo
            solarProd = Math.max(solarProd, state.productionToday);
        }

        let houseCons = 0;
        const current = dailyGridMap[dateKey];
        const prevDateKey = formatDate(addDays(d, -1));
        const previous = dailyGridMap[prevDateKey];

        if (current && previous) houseCons = calculateHouseConsumption(solarProd, current, previous);

        dailyData.push({ label: dateKey.slice(0, 5), production: solarProd, consumption: houseCons });
    }
    // ... restante da função de renderização do Chart.js
}