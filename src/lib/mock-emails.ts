import { EmailThread } from '@/types';

export const mockThreads: EmailThread[] = [
  {
    id: 'thread-1',
    subject: 'Demande de remboursement - Commande #4521',
    participants: ['client@example.com', 'support@entreprise.com'],
    lastMessageDate: '2024-03-15T14:30:00Z',
    messages: [
      {
        id: 'msg-1a',
        from: 'client@example.com',
        to: 'support@entreprise.com',
        subject: 'Demande de remboursement - Commande #4521',
        body: "Bonjour,\n\nJ'ai passé la commande #4521 le 10 mars et je n'ai toujours rien reçu. Le suivi indique que le colis est perdu. Je souhaite un remboursement complet.\n\nCordialement,\nJean Dupont",
        date: '2024-03-14T09:15:00Z',
      },
      {
        id: 'msg-1b',
        from: 'support@entreprise.com',
        to: 'client@example.com',
        subject: 'Re: Demande de remboursement - Commande #4521',
        body: "Bonjour Jean,\n\nNous sommes désolés pour ce désagrément. Nous avons vérifié et le colis est effectivement en statut \"perdu\" auprès du transporteur. Pouvez-vous nous confirmer l'adresse de livraison utilisée ?\n\nCordialement,\nService Client",
        date: '2024-03-14T14:00:00Z',
      },
      {
        id: 'msg-1c',
        from: 'client@example.com',
        to: 'support@entreprise.com',
        subject: 'Re: Re: Demande de remboursement - Commande #4521',
        body: "Bonjour,\n\nL'adresse est : 12 rue de la Paix, 75002 Paris. C'est bien l'adresse qui figure sur la commande. Je préfère un remboursement plutôt qu'un renvoi.\n\nMerci,\nJean Dupont",
        date: '2024-03-15T14:30:00Z',
      },
    ],
  },
  {
    id: 'thread-2',
    subject: 'Problème technique - Application mobile',
    participants: ['marie.martin@email.fr', 'tech@entreprise.com'],
    lastMessageDate: '2024-03-16T11:00:00Z',
    messages: [
      {
        id: 'msg-2a',
        from: 'marie.martin@email.fr',
        to: 'tech@entreprise.com',
        subject: 'Problème technique - Application mobile',
        body: "Bonjour,\n\nDepuis la dernière mise à jour, l'application plante systématiquement quand j'essaie d'accéder à mon historique de commandes. J'utilise un iPhone 14 sous iOS 17.3.\n\nMerci de votre aide,\nMarie Martin",
        date: '2024-03-16T08:30:00Z',
      },
      {
        id: 'msg-2b',
        from: 'tech@entreprise.com',
        to: 'marie.martin@email.fr',
        subject: 'Re: Problème technique - Application mobile',
        body: "Bonjour Marie,\n\nMerci pour votre signalement. Nous avons identifié un bug sur iOS 17.3. Un correctif est en cours de déploiement. En attendant, essayez de vider le cache de l'application.\n\nCordialement,\nSupport Technique",
        date: '2024-03-16T11:00:00Z',
      },
    ],
  },
  {
    id: 'thread-3',
    subject: 'Partenariat commercial - Proposition',
    participants: ['directeur@partenaire.com', 'commercial@entreprise.com'],
    lastMessageDate: '2024-03-17T16:45:00Z',
    messages: [
      {
        id: 'msg-3a',
        from: 'directeur@partenaire.com',
        to: 'commercial@entreprise.com',
        subject: 'Partenariat commercial - Proposition',
        body: "Bonjour,\n\nNous sommes une entreprise spécialisée dans la distribution B2B et nous aimerions discuter d'un partenariat commercial avec vous. Nous avons un réseau de 500 points de vente en France.\n\nSeriez-vous disponible pour un appel cette semaine ?\n\nCordialement,\nPierre Moreau\nDirecteur Commercial\nPartenaire SAS",
        date: '2024-03-17T10:00:00Z',
      },
      {
        id: 'msg-3b',
        from: 'commercial@entreprise.com',
        to: 'directeur@partenaire.com',
        subject: 'Re: Partenariat commercial - Proposition',
        body: "Bonjour Pierre,\n\nMerci pour votre intérêt. Votre proposition nous intéresse beaucoup. Pouvez-vous nous envoyer une présentation détaillée de votre réseau et de vos conditions ?\n\nNous sommes disponibles jeudi ou vendredi pour un appel.\n\nCordialement,\nService Commercial",
        date: '2024-03-17T16:45:00Z',
      },
    ],
  },
  {
    id: 'thread-4',
    subject: 'Réclamation - Produit défectueux',
    participants: ['sophie.leroy@mail.com', 'sav@entreprise.com'],
    lastMessageDate: '2024-03-18T09:20:00Z',
    messages: [
      {
        id: 'msg-4a',
        from: 'sophie.leroy@mail.com',
        to: 'sav@entreprise.com',
        subject: 'Réclamation - Produit défectueux',
        body: "Bonjour,\n\nJ'ai acheté un aspirateur modèle XR-500 il y a 2 semaines et il ne fonctionne déjà plus. Le moteur fait un bruit anormal et l'aspiration est quasi inexistante. C'est inadmissible pour un produit à ce prix.\n\nJe demande un échange immédiat ou un remboursement.\n\nSophie Leroy\nN° client : CL-78542",
        date: '2024-03-18T09:20:00Z',
      },
    ],
  },
];
