-- SemiconLabs coupon service: database schema (PostgreSQL 16)
-- Generated from the live schema with pg_dump; the app also creates any missing tables at start-up.
-- Apply on an empty database:  psql -U semicon -d coupons -f coupon-service/db/schema.sql

\restrict 0GpVphgmT630kVK4919OYfF9BF2P5GnVq5hGcJgvHf6Nhps7nR1FTmc88wPNC8q

-- Name: coupon_svc; Type: SCHEMA; Schema: -; Owner: -

CREATE SCHEMA IF NOT EXISTS coupon_svc;

-- Name: admin_sessions; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.admin_sessions (
    token_hash character varying(64) NOT NULL,
    admin_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    ip character varying(64)
);

-- Name: admin_users; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.admin_users (
    id bigint NOT NULL,
    username character varying(60) NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);

-- Name: admin_users_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.admin_users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: admin_users_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.admin_users_id_seq OWNED BY coupon_svc.admin_users.id;

-- Name: campaigns; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.campaigns (
    id bigint NOT NULL,
    name text NOT NULL,
    kind character varying(20) NOT NULL,
    offer_id bigint NOT NULL,
    referrer_offer_id bigint,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    max_redemptions integer,
    redeemed_count integer DEFAULT 0 NOT NULL,
    max_per_user integer,
    first_purchase_only boolean DEFAULT false NOT NULL,
    status character varying(10) DEFAULT 'active'::character varying NOT NULL,
    meta jsonb,
    CONSTRAINT valid_window CHECK ((ends_at > starts_at))
);

-- Name: campaigns_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.campaigns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.campaigns_id_seq OWNED BY coupon_svc.campaigns.id;

-- Name: coupon_codes; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.coupon_codes (
    id bigint NOT NULL,
    campaign_id bigint NOT NULL,
    offer_id bigint,
    code character varying(40) NOT NULL,
    assigned_user_id bigint,
    pin_hash text,
    pin_attempts smallint DEFAULT '0'::smallint NOT NULL,
    max_uses integer,
    used_count integer DEFAULT 0 NOT NULL,
    status character varying(10) DEFAULT 'active'::character varying NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: coupon_codes_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.coupon_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: coupon_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.coupon_codes_id_seq OWNED BY coupon_svc.coupon_codes.id;

-- Name: coupon_events; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.coupon_events (
    id bigint NOT NULL,
    event_type character varying(20) NOT NULL,
    campaign_id bigint,
    coupon_code_id bigint,
    user_id bigint,
    reason text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: coupon_events_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.coupon_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: coupon_events_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.coupon_events_id_seq OWNED BY coupon_svc.coupon_events.id;

-- Name: offers; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.offers (
    id bigint NOT NULL,
    name text NOT NULL,
    benefit_type character varying(20) NOT NULL,
    value numeric(12,2) NOT NULL,
    max_discount numeric(12,2),
    min_cart numeric(12,2),
    meta jsonb,
    is_active boolean DEFAULT true NOT NULL,
    description text
);

-- Name: offers_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.offers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: offers_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.offers_id_seq OWNED BY coupon_svc.offers.id;

-- Name: orders; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.orders (
    id text NOT NULL,
    user_id bigint NOT NULL,
    status character varying(10) NOT NULL,
    subtotal numeric(12,2),
    discount numeric(12,2),
    coupon_code text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: redemptions; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.redemptions (
    id bigint NOT NULL,
    coupon_code_id bigint NOT NULL,
    campaign_id bigint NOT NULL,
    user_id bigint NOT NULL,
    order_id text NOT NULL,
    status character varying(10) NOT NULL,
    cart_subtotal numeric(12,2) NOT NULL,
    discount_applied numeric(12,2) NOT NULL,
    reserved_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_at timestamp with time zone
);

-- Name: redemptions_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.redemptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: redemptions_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.redemptions_id_seq OWNED BY coupon_svc.redemptions.id;

-- Name: referrals; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.referrals (
    id bigint NOT NULL,
    referrer_id bigint NOT NULL,
    referee_id bigint NOT NULL,
    referrer_code_id bigint,
    referee_code_id bigint,
    status character varying(10) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    converted_at timestamp with time zone
);

-- Name: referrals_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.referrals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: referrals_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.referrals_id_seq OWNED BY coupon_svc.referrals.id;

-- Name: users; Type: TABLE; Schema: coupon_svc; Owner: -

CREATE TABLE coupon_svc.users (
    id bigint NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    account_type character varying(20) NOT NULL,
    referral_code character varying(20) NOT NULL,
    referred_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: users_id_seq; Type: SEQUENCE; Schema: coupon_svc; Owner: -

CREATE SEQUENCE coupon_svc.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: coupon_svc; Owner: -

ALTER SEQUENCE coupon_svc.users_id_seq OWNED BY coupon_svc.users.id;

-- Name: admin_users id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.admin_users ALTER COLUMN id SET DEFAULT nextval('coupon_svc.admin_users_id_seq'::regclass);

-- Name: campaigns id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.campaigns ALTER COLUMN id SET DEFAULT nextval('coupon_svc.campaigns_id_seq'::regclass);

-- Name: coupon_codes id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.coupon_codes ALTER COLUMN id SET DEFAULT nextval('coupon_svc.coupon_codes_id_seq'::regclass);

-- Name: coupon_events id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.coupon_events ALTER COLUMN id SET DEFAULT nextval('coupon_svc.coupon_events_id_seq'::regclass);

-- Name: offers id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.offers ALTER COLUMN id SET DEFAULT nextval('coupon_svc.offers_id_seq'::regclass);

-- Name: redemptions id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.redemptions ALTER COLUMN id SET DEFAULT nextval('coupon_svc.redemptions_id_seq'::regclass);

-- Name: referrals id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.referrals ALTER COLUMN id SET DEFAULT nextval('coupon_svc.referrals_id_seq'::regclass);

-- Name: users id; Type: DEFAULT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.users ALTER COLUMN id SET DEFAULT nextval('coupon_svc.users_id_seq'::regclass);

-- Name: admin_sessions admin_sessions_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.admin_sessions
    ADD CONSTRAINT admin_sessions_pkey PRIMARY KEY (token_hash);

-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);

-- Name: admin_users admin_users_username_key; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.admin_users
    ADD CONSTRAINT admin_users_username_key UNIQUE (username);

-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);

-- Name: coupon_codes coupon_codes_code_key; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.coupon_codes
    ADD CONSTRAINT coupon_codes_code_key UNIQUE (code);

-- Name: coupon_codes coupon_codes_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.coupon_codes
    ADD CONSTRAINT coupon_codes_pkey PRIMARY KEY (id);

-- Name: coupon_events coupon_events_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.coupon_events
    ADD CONSTRAINT coupon_events_pkey PRIMARY KEY (id);

-- Name: offers offers_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);

-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

-- Name: redemptions redemptions_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.redemptions
    ADD CONSTRAINT redemptions_pkey PRIMARY KEY (id);

-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);

-- Name: referrals referrals_referee_id_key; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.referrals
    ADD CONSTRAINT referrals_referee_id_key UNIQUE (referee_id);

-- Name: users users_email_key; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

-- Name: users users_pkey; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

-- Name: users users_referral_code_key; Type: CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.users
    ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);

-- Name: ix_admin_sessions_admin_id; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE INDEX ix_admin_sessions_admin_id ON coupon_svc.admin_sessions USING btree (admin_id);

-- Name: ix_coupon_codes_assigned_user_id; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE INDEX ix_coupon_codes_assigned_user_id ON coupon_svc.coupon_codes USING btree (assigned_user_id);

-- Name: ix_coupon_codes_campaign_id; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE INDEX ix_coupon_codes_campaign_id ON coupon_svc.coupon_codes USING btree (campaign_id);

-- Name: ix_coupon_events_created_at; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE INDEX ix_coupon_events_created_at ON coupon_svc.coupon_events USING btree (created_at);

-- Name: ix_coupon_events_event_type; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE INDEX ix_coupon_events_event_type ON coupon_svc.coupon_events USING btree (event_type);

-- Name: ix_orders_user_id; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE INDEX ix_orders_user_id ON coupon_svc.orders USING btree (user_id);

-- Name: one_coupon_per_order; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE UNIQUE INDEX one_coupon_per_order ON coupon_svc.redemptions USING btree (order_id) WHERE ((status)::text <> 'released'::text);

-- Name: redemptions_campaign_user; Type: INDEX; Schema: coupon_svc; Owner: -

CREATE INDEX redemptions_campaign_user ON coupon_svc.redemptions USING btree (campaign_id, user_id);

-- Name: admin_sessions admin_sessions_admin_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.admin_sessions
    ADD CONSTRAINT admin_sessions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES coupon_svc.admin_users(id) ON DELETE CASCADE;

-- Name: campaigns campaigns_offer_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.campaigns
    ADD CONSTRAINT campaigns_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES coupon_svc.offers(id);

-- Name: campaigns campaigns_referrer_offer_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.campaigns
    ADD CONSTRAINT campaigns_referrer_offer_id_fkey FOREIGN KEY (referrer_offer_id) REFERENCES coupon_svc.offers(id);

-- Name: coupon_codes coupon_codes_campaign_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.coupon_codes
    ADD CONSTRAINT coupon_codes_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES coupon_svc.campaigns(id);

-- Name: coupon_codes coupon_codes_offer_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.coupon_codes
    ADD CONSTRAINT coupon_codes_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES coupon_svc.offers(id);

-- Name: redemptions redemptions_campaign_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.redemptions
    ADD CONSTRAINT redemptions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES coupon_svc.campaigns(id);

-- Name: redemptions redemptions_coupon_code_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.redemptions
    ADD CONSTRAINT redemptions_coupon_code_id_fkey FOREIGN KEY (coupon_code_id) REFERENCES coupon_svc.coupon_codes(id);

-- Name: referrals referrals_referee_code_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.referrals
    ADD CONSTRAINT referrals_referee_code_id_fkey FOREIGN KEY (referee_code_id) REFERENCES coupon_svc.coupon_codes(id);

-- Name: referrals referrals_referrer_code_id_fkey; Type: FK CONSTRAINT; Schema: coupon_svc; Owner: -

ALTER TABLE ONLY coupon_svc.referrals
    ADD CONSTRAINT referrals_referrer_code_id_fkey FOREIGN KEY (referrer_code_id) REFERENCES coupon_svc.coupon_codes(id);

\unrestrict 0GpVphgmT630kVK4919OYfF9BF2P5GnVq5hGcJgvHf6Nhps7nR1FTmc88wPNC8q

