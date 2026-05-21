// script.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('Restaurant List Pipeline LP Loaded Successfully.');

    // 既存のダウンロードログ処理
    const downloadButtons = document.querySelectorAll('.download-btn');
    downloadButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const fileType = btn.textContent.includes('zip') ? 'System Package' : 'Sample CSV';
            console.log(`${fileType} download triggered.`);
        });
    });

    // ============================================================
    // デモ機能 (ドラッグ＆ドロップ CSV クレンジング)
    // ============================================================
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('csvFileInput');
    const demoProcess = document.getElementById('demoProcess');
    const demoProgressBar = document.getElementById('demoProgressBar');
    const demoProgressText = document.getElementById('demoProgressText');
    const demoDashboard = document.getElementById('demoDashboard');
    const demoResults = document.getElementById('demoResults');
    const resultTableBody = document.getElementById('demoResultTableBody');
    const downloadBtn = document.getElementById('demoDownloadBtn');

    // 統計要素
    const statTotal = document.getElementById('statTotal');
    const statDupes = document.getElementById('statDupes');
    const statChains = document.getElementById('statChains');
    const statPhones = document.getElementById('statPhones');
    const statFinal = document.getElementById('statFinal');

    let processedData = []; // ダウンロード用のクレンジング済みデータ

    if (!dropZone || !fileInput) return;

    // ドラッグ＆ドロップイベントの制御
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    }, false);

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    // ファイル処理の本体
    function handleFile(file) {
        if (!file.name.endsWith('.csv')) {
            alert('CSVファイル (.csv) を選択してください。');
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            processDemo(text);
        };
        reader.readAsText(file);
    }

    // CSVパーサー（ダブルクォーテーション対応）
    function parseCSV(text) {
        const lines = [];
        let row = [""];
        let inQuotes = false;
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = text[i + 1];
            
            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    row[row.length - 1] += '"';
                    i++; // 二重クォートのエスケープをスキップ
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                row.push("");
            } else if ((char === '\r' || char === '\n') && !inQuotes) {
                if (char === '\r' && nextChar === '\n') {
                    i++;
                }
                lines.push(row);
                row = [""];
            } else {
                row[row.length - 1] += char;
            }
        }
        if (row.length > 1 || row[0] !== "") {
            lines.push(row);
        }
        return lines;
    }

    // 住所の正規化（名寄せ判定用）
    function normalizeAddress(addr) {
        if (!addr) return "";
        let s = addr;
        // 郵便番号を除去
        s = s.replace(/〒?\s*\d{3}[-\s]?\d{4}/g, '');
        // スペース類を除去
        s = s.replace(/\s+/g, '');
        // 全角英数字を半角に変換
        s = s.replace(/[０-９ａ-ｚＡ-Ｚ]/g, function(m) {
            return String.fromCharCode(m.charCodeAt(0) - 0xFEE0);
        });
        // 漢数字を半角数字に変換（簡易）
        s = s.replace(/[一二三四五六七八九十]/g, function(m) {
            const mapping = {
                '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
                '六': '6', '七': '7', '八': '8', '九': '9', '十': '10'
            };
            return mapping[m];
        });
        // 丁目、番地、号、ハイフン記号などを除去して数字部分を統合
        s = s.replace(/[丁目番地号号室ー\-]/g, '');
        return s;
    }

    // 電話番号の正規化
    function normalizePhone(phone) {
        if (!phone) return "";
        return phone.replace(/[^\d]/g, '');
    }

    // 大手チェーン店の正規表現パターン
    const CHAIN_PATTERNS = [
        /マクドナルド/i, /マック/i, /スターバックス/i, /スタバ/i,
        /サイゼリヤ/i, /吉野家/i, /すき家/i, /松屋/i,
        /ガスト/i, /鳥貴族/i, /ケンタッキー/i, /コメダ珈琲/i,
        /ドトール/i, /タリーズ/i, /丸亀製麺/i, /スシロー/i,
        /くら寿司/i, /はま寿司/i, /餃子の王将/i, /大阪王将/i,
        /バーミヤン/i, /ジョナサン/i, /ココス/i, /デニーズ/i,
        /なか卯/i, /ココイチ/i, /CoCo壱/i, /大戸屋/i,
        /やよい軒/i, /モスバーガー/i
    ];

    // デモ処理のシミュレーション
    function processDemo(csvText) {
        // UI初期化
        demoProcess.style.display = 'block';
        demoDashboard.style.display = 'none';
        demoResults.style.display = 'none';
        resultTableBody.innerHTML = '';
        processedData = [];

        // プログレスバーの更新ユーティリティ
        const updateProgress = (pct, text) => {
            demoProgressBar.style.width = `${pct}%`;
            demoProgressText.textContent = text;
        };

        // 1. CSVパース (500ms)
        updateProgress(10, 'CSVファイルを解析中...');
        
        setTimeout(() => {
            const rawRows = parseCSV(csvText);
            if (rawRows.length < 2) {
                alert('有効なデータが含まれていないか、ヘッダー行のみのファイルです。');
                demoProcess.style.display = 'none';
                return;
            }

            const header = rawRows[0];
            const body = rawRows.slice(1).filter(r => r.length >= 2 && r[0].trim() !== "");

            updateProgress(30, '重複データをチェック中（名寄せ処理）...');

            // 2. 名寄せ・重複チェック (800ms)
            setTimeout(() => {
                const phoneSet = new Set();
                const addressSet = new Set();
                const intermediateRows = [];

                let dupeCount = 0;

                body.forEach(row => {
                    const name = row[0] || '';
                    const genre = row[1] || '';
                    const address = row[2] || '';
                    const phone = row[3] || '';
                    const holiday = row[4] || '';
                    const hours = row[5] || '';
                    const url = row[6] || '';
                    const source = row[7] || '';

                    const normPhone = normalizePhone(phone);
                    const normAddress = normalizeAddress(address);

                    let isDupe = false;

                    // 電話番号が存在し、すでに登録されている場合
                    if (normPhone && phoneSet.has(normPhone)) {
                        isDupe = true;
                    } 
                    // もしくは住所が存在し、すでに登録されている場合
                    else if (normAddress && addressSet.has(normAddress)) {
                        isDupe = true;
                    }

                    if (isDupe) {
                        dupeCount++;
                        intermediateRows.push({
                            data: { name, genre, address, phone, holiday, hours, url, source },
                            status: 'duplicate'
                        });
                    } else {
                        if (normPhone) phoneSet.add(normPhone);
                        if (normAddress) addressSet.add(normAddress);
                        intermediateRows.push({
                            data: { name, genre, address, phone, holiday, hours, url, source },
                            status: 'valid'
                        });
                    }
                });

                updateProgress(60, '大手チェーン店を識別・除外中...');

                // 3. チェーン店除外 (800ms)
                setTimeout(() => {
                    let chainCount = 0;

                    intermediateRows.forEach(item => {
                        if (item.status === 'valid') {
                            const isChain = CHAIN_PATTERNS.some(pattern => pattern.test(item.data.name));
                            if (isChain) {
                                item.status = 'chain';
                                chainCount++;
                            }
                        }
                    });

                    updateProgress(80, '未取得の電話番号をホームページから自動クローリング中...');

                    // 4. 電話番号回収シミュレータ (1500ms)
                    setTimeout(() => {
                        let phoneRecoveredCount = 0;

                        intermediateRows.forEach(item => {
                            // 除外されていない行で、かつ電話番号が空欄の場合
                            if (item.status === 'valid' && (!item.data.phone || item.data.phone.trim() === "")) {
                                // ホームページURLが存在する場合に自動回収を模倣
                                if (item.data.url && item.data.url.trim() !== "") {
                                    // 名前やURLに基づいてダミー電話番号を特定する
                                    if (item.data.name.includes("八坂")) {
                                        item.data.phone = "048-832-1254"; // 八坂用の固定検証電話番号
                                    } else {
                                        // ランダム生成
                                        const rand = Math.floor(1000 + Math.random() * 9000);
                                        item.data.phone = `048-825-${rand}`;
                                    }
                                    item.status = 'completed'; // 電話番号補完完了ステータス
                                    phoneRecoveredCount++;
                                }
                            }
                        });

                        updateProgress(100, 'クレンジング完了！ダッシュボードを展開しています...');

                        // 5. 完了＆ダッシュボード表示 (400ms)
                        setTimeout(() => {
                            demoProcess.style.display = 'none';

                            // 統計値のセット
                            const finalCount = body.length - dupeCount - chainCount;
                            statTotal.textContent = body.length;
                            statDupes.textContent = dupeCount;
                            statChains.textContent = chainCount;
                            statPhones.textContent = phoneRecoveredCount;
                            statFinal.textContent = finalCount;

                            // プレビューの描画
                            renderDemoTable(intermediateRows);

                            // データ保存
                            processedData = intermediateRows
                                .filter(item => item.status === 'valid' || item.status === 'completed')
                                .map(item => item.data);

                            demoDashboard.style.display = 'grid';
                            demoResults.style.display = 'block';

                            // デモ結果位置までスムーズスクロール
                            demoDashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }, 400);

                    }, 1500);

                }, 800);

            }, 800);

        }, 500);
    }

    // 結果テーブルの描画
    function renderDemoTable(items) {
        resultTableBody.innerHTML = '';
        items.forEach(item => {
            const tr = document.createElement('tr');
            let statusBadge = '';
            
            switch (item.status) {
                case 'valid':
                    statusBadge = '<span class="status-badge status-normal">正常出力</span>';
                    break;
                case 'duplicate':
                    statusBadge = '<span class="status-badge status-dupe">重複排除</span>';
                    tr.classList.add('row-ignored');
                    break;
                case 'chain':
                    statusBadge = '<span class="status-badge status-chain">チェーン除外</span>';
                    tr.classList.add('row-ignored');
                    break;
                case 'completed':
                    statusBadge = '<span class="status-badge status-completed">電話番号補完</span>';
                    break;
            }

            const phoneVal = item.status === 'completed' 
                ? `<strong style="color: var(--primary);">${esc(item.data.phone)}</strong>`
                : esc(item.data.phone || 'ー');

            const mediaTag = item.data.source === 'tabelog' 
                ? '<span class="tag tabelog">tabelog</span>' 
                : (item.data.source === 'hotpepper' ? '<span class="tag hotpepper">hotpepper</span>' : '<span class="tag gmaps">googlemaps</span>');

            tr.innerHTML = `
                <td>${statusBadge}</td>
                <td><strong>${esc(item.data.name)}</strong></td>
                <td>${esc(item.data.genre)}</td>
                <td>${esc(item.data.address)}</td>
                <td>${phoneVal}</td>
                <td>${mediaTag}</td>
            `;
            resultTableBody.appendChild(tr);
        });
    }

    // エスケープ
    function esc(s) {
        return String(s || '')
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // クレンジング済みCSVダウンロードの実行
    downloadBtn.addEventListener('click', () => {
        if (processedData.length === 0) return;

        const headers = ['店名', 'ジャンル', '住所', '電話番号', '定休日', '営業時間', 'URL', '媒体'];
        const ef = v => {
            const s = String(v ?? '');
            return (s.includes(',') || s.includes('\n') || s.includes('"'))
                ? '"' + s.replace(/"/g, '""') + '"'
                : s;
        };

        const rows = processedData.map(d => [
            ef(d.name),
            ef(d.genre),
            ef(d.address),
            ef(d.phone),
            ef(d.holiday),
            ef(d.hours),
            ef(d.url),
            ef(d.source)
        ].join(','));

        const csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `cleaned_restaurant_list_${ts}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
});
