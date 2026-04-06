package com.example.ringtonemasterv2

import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Binder
import android.os.IBinder
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.ui.PlayerNotificationManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@UnstableApi
class MusicService : MediaSessionService() {

    private lateinit var player: ExoPlayer
    private lateinit var notificationManager: PlayerNotificationManager
    private val binder = MusicBinder()
    private var currentVideoId: String? = null
    private var mediaSession: MediaSession? = null
    private var currentBitmap: Bitmap? = null

    inner class MusicBinder : Binder() {
        fun getService(): MusicService = this@MusicService
    }

    override fun onCreate() {
        super.onCreate()

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        player = ExoPlayer.Builder(this)
            .setAudioAttributes(audioAttributes, true)
            .setHandleAudioBecomingNoisy(true)
            .build()

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    val intent = Intent("TRACK_ENDED")
                    sendBroadcast(intent)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (currentVideoId == null) return
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        val api = MediaApi(this@MusicService)
                        val newUrl = api.getAudioUrl(currentVideoId!!)
                        if (!newUrl.isNullOrEmpty()) {
                            withContext(Dispatchers.Main) {
                                play(newUrl, currentVideoId, null)
                            }
                        }
                    } catch (e: Exception) {
                        android.util.Log.e("SERVICE_ERROR", "Repair failed: ${e.message}")
                    }
                }
            }
        })

        // MediaSession oluştur
        val sessionActivityIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        mediaSession = MediaSession.Builder(this, player)
            .setSessionActivity(sessionActivityIntent)
            .build()

        // ========== BİLDİRİM YÖNETİMİ (PlayerNotificationManager) ==========
        notificationManager = PlayerNotificationManager.Builder(
            this,
            1,
            "music_channel"
        )
            .setMediaDescriptionAdapter(object : PlayerNotificationManager.MediaDescriptionAdapter {
                override fun getCurrentContentTitle(player: Player): CharSequence {
                    return player.mediaMetadata.title ?: "Ringtone Master"
                }

                override fun createCurrentContentIntent(player: Player): PendingIntent? {
                    return sessionActivityIntent
                }

                override fun getCurrentContentText(player: Player): CharSequence? {
                    return player.mediaMetadata.artist
                }

                override fun getCurrentLargeIcon(
                    player: Player,
                    callback: PlayerNotificationManager.BitmapCallback
                ): Bitmap? {
                    return currentBitmap
                }
            })
            .setNotificationListener(object : PlayerNotificationManager.NotificationListener {
                override fun onNotificationPosted(
                    notificationId: Int,
                    notification: Notification,
                    ongoing: Boolean
                ) {
                    // KRİTİK: Her zaman startForeground çağır (sadece ongoing değil!)
                    startForeground(notificationId, notification)
                }

                override fun onNotificationCancelled(
                    notificationId: Int,
                    dismissedByUser: Boolean
                ) {
                    stopForeground(true)
                    stopSelf()
                }
            })
            .build()

        notificationManager.setPlayer(player)
        notificationManager.setMediaSessionToken(mediaSession!!.sessionCompatToken)
        // =====================================================================
    }

    // ★ KRİTİK FİX: MediaSessionService'in kendi bildirimini ENGELLE
    // Böylece PlayerNotificationManager ile çakışma olmaz
    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        // BOŞ BIRAK — bildirimi PlayerNotificationManager yönetiyor
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return mediaSession
    }

    override fun onBind(intent: Intent?): IBinder? {
        // FIX: super.onBind() sadece 1 kere çağrılıyor (eski kodda 2 kere çağrılıyordu)
        if (intent?.action == SERVICE_INTERFACE) {
            return super.onBind(intent)
        }
        return binder
    }

    fun play(url: String, videoId: String? = null, metadata: MediaMetadata? = null) {
        // Kapak resmini arka planda indir
        metadata?.artworkUri?.let { uri ->
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val stream = java.net.URL(uri.toString()).openStream()
                    val bitmap = BitmapFactory.decodeStream(stream)
                    withContext(Dispatchers.Main) {
                        currentBitmap = bitmap
                        // Bitmap hazır olunca notification'ı güncelle
                        notificationManager.invalidate()
                    }
                } catch (_: Exception) {}
            }
        }

        currentVideoId = videoId
        player.stop()
        player.clearMediaItems()

        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000) // yt-dlp'nin videoyu çözümlemesine izin ver (15 saniye)
            .setReadTimeoutMs(30000)    // Okuma işleminde donmaları tolere et (30 saniye)

        val dataSourceFactory = DefaultDataSource.Factory(this, httpDataSourceFactory)

        val mediaItem = MediaItem.Builder()
            .setUri(url)
            .setMediaMetadata(metadata ?: MediaMetadata.EMPTY)
            .build()

        val mediaSource = ProgressiveMediaSource.Factory(
            dataSourceFactory,
            DefaultExtractorsFactory()
        ).createMediaSource(mediaItem)

        player.setMediaSource(mediaSource)
        player.prepare()
        player.playWhenReady = true
    }

    fun pause() = player.pause()
    fun resume() = player.play()
    fun isPlaying() = player.isPlaying
    fun getCurrentPosition() = player.currentPosition
    fun getDuration() = player.duration
    fun seekTo(position: Long) { player.seekTo(position) }
    fun getPlayer(): ExoPlayer = player

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            "PLAY" -> resume()
            "PAUSE" -> pause()
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!player.playWhenReady || player.playbackState == Player.STATE_ENDED) {
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        notificationManager.setPlayer(null)
        mediaSession?.run {
            player.release()
            release()
        }
        mediaSession = null
        super.onDestroy()
    }
}
