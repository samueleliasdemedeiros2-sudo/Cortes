const multer = require('multer');
const upload = multer({ dest: '/tmp/uploads/' });

// ROTA PARA VÍDEOS NORMAIS ENVIADOS PELO USUÁRIO
app.post('/api/upload-process', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Nenhum vídeo enviado.' });
        }

        const duration = parseInt(req.body.duration) || 60;
        
        // Aqui o servidor simula ou processa os trechos do vídeo enviado
        // Em produção, você pode usar FFmpeg para gerar cortes locais ou enviar o trecho para o Gemini analisar
        const mockClips = [
            {
                title: "Melhor Momento - Destaque IA",
                start: 0,
                end: duration,
                duration: duration,
                downloadUrl: `/uploads/${req.file.filename}` // ou URL temporária do arquivo cortado
            }
        ];

        return res.json({ success: true, clips: mockClips });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, error: 'Erro ao processar o vídeo.' });
    }
});
