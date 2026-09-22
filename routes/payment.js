const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { generateQRCodeDataUrl, getTicketsForBooking } = require('../services/qrService');
const { UPLOAD_DIR } = require('../services/storagePaths');
const { createImageUpload, fileSignatureValid } = require('../services/imageUpload');

const uploadBukti = createImageUpload('bukti');

router.post('/submit-proof', (req, res) => {
  uploadBukti.single('bukti_pembayaran')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'Gagal mengunggah file.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Bukti pembayaran wajib diunggah.' });
    }

    const cleanupUploadedFile = () => fs.unlink(req.file.path, () => {});

    if (!fileSignatureValid(req.file.path, req.file.mimetype)) {
      cleanupUploadedFile();
      return res.status(400).json({ success: false, message: 'File tidak dikenali sebagai gambar yang valid.' });
    }

    const { order_id } = req.body;
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(order_id);

    if (!booking) {
      cleanupUploadedFile();
      return res.status(404).json({ success: false, message: 'Pemesanan tidak ditemukan.' });
    }
    if (booking.status_pembayaran === 'paid') {
      cleanupUploadedFile();
      return res.status(400).json({ success: false, message: 'Pemesanan ini sudah dibayar.' });
    }
    if (booking.status_pembayaran === 'failed') {
      cleanupUploadedFile();
      return res.status(400).json({ success: false, message: 'Pemesanan ini sudah ditandai gagal oleh panitia. Silakan buat pesanan baru.' });
    }

    if (booking.bukti_pembayaran) {
      fs.unlink(path.join(UPLOAD_DIR, booking.bukti_pembayaran), () => {});
    }

    db.prepare(`
      UPDATE bookings SET bukti_pembayaran = ?, metode_pembayaran = 'manual'
      WHERE id = ?
    `).run(req.file.filename, order_id);

    res.json({ success: true, message: 'Bukti pembayaran berhasil dikirim. Menunggu verifikasi panitia.' });
  });
});

router.post('/lookup', (req, res) => {
  const orderId = (req.body.order_id || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();

  if (!orderId || !email) {
    return res.status(400).json({ success: false, message: 'Email dan Booking ID wajib diisi.' });
  }

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(orderId);

  if (!booking || booking.email.trim().toLowerCase() !== email) {
    return res.status(404).json({ success: false, message: 'Data tidak ditemukan. Pastikan Email dan Booking ID sudah benar.' });
  }

  if (booking.status_pembayaran === 'paid') {
    return res.json({ success: true, status: 'paid' });
  }
  if (booking.status_pembayaran === 'failed') {
    return res.json({ success: true, status: 'failed' });
  }
  return res.json({ success: true, status: 'pending', ada_bukti: !!booking.bukti_pembayaran });
});

router.get('/ticket/:orderId', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.orderId);

  if (!booking || !email || booking.email.trim().toLowerCase() !== email) {
    return res.status(404).json({ success: false, message: 'Data tidak ditemukan. Pastikan Email dan Booking ID sudah benar.' });
  }
  if (booking.status_pembayaran !== 'paid') {
    return res.status(400).json({ success: false, message: 'Pembayaran belum dikonfirmasi oleh panitia.' });
  }

  const ticketRows = getTicketsForBooking(booking.id);
  const tickets = await Promise.all(ticketRows.map(async (t) => ({
    kode_tiket: t.kode_tiket,
    urutan: t.urutan,
    checked_in: !!t.checked_in,
    qr_code: await generateQRCodeDataUrl(t.kode_tiket)
  })));

  res.json({ success: true, booking, tickets });
});

module.exports = router;
