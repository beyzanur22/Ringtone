package com.example.ringtonemasterv2

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.localization.Localization

class MyApp : Application() {

    override fun onCreate() {
        super.onCreate()

        // 1. Register Notification Channel (Android 8.0+)
        createNotificationChannel()

        try {
            NewPipe.init(
                DownloaderImpl(),
                Localization.DEFAULT
            )
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {

            // ÖNCEKİ KANALI SİL (importance değişikliği için zorunlu)
            val manager = getSystemService(NotificationManager::class.java)
            manager.deleteNotificationChannel("music_channel")

            // YENİ KANAL OLUŞTUR
            val channel = NotificationChannel(
                "music_channel",
                "Music Playback",
                NotificationManager.IMPORTANCE_DEFAULT  // LOW değil DEFAULT — gerçek telefonda görünür
            ).apply {
                description = "Media controls for music playback"
                setShowBadge(false)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC  // Kilit ekranında görünsün
            }
            manager.createNotificationChannel(channel)
        }
    }
}
